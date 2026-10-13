// The email-digest sweep (leader-only, SKILLY_SPEC.md §48.6–§48.8). The delivery sweep (deliver.ts)
// parks a digestible row's email as `digest_state = 'pending'`; this job, every few minutes:
//
//   1. drops the pending rows of anyone no longer in digest mode (switched back, admin default
//      changed, kill switch, email off) — forward-only, nothing is flushed by email;
//   2. for each digest user whose current slot has passed since their last stamp: drops pending
//      rows already read in-app or failing a re-check (visibility, archived/deleted skill, deleted
//      request), sends ONE digest of the rest, and stamps the slot. First sight (no stamp yet)
//      stamps without sending, and any number of missed slots still yields one digest.
//
// Failures follow §12: no operational transport → the rows are dropped and the slot stamped (never
// burst-sent later); a transient error retries on the next pass up to NOTIFY_MAX_ATTEMPTS; a Graph
// 429 consumes no attempt and returns Retry-After so the caller pauses with the delivery sweep.
import type { Pool } from "pg";
import { GraphSendError } from "@skilly/shared/email";
import {
  digestDue,
  digestSlot,
  effectiveDigestMode,
  renderDigest,
  userCanSeeSkillSql,
  type DigestRow,
  type DigestSettings,
} from "@skilly/shared";
import { notificationBodySentence, type EmailTransport } from "./deliver.js";

const MAX_ATTEMPTS = Number(process.env.NOTIFY_MAX_ATTEMPTS ?? 5);

export interface DigestSweepResult {
  /** Digests that went out. */
  sent: number;
  /** Due users with nothing left to send (slot stamped, no email). */
  empty: number;
  /** Pending rows settled as `dropped` this pass. */
  dropped: number;
  /** Transient send failures (rows kept for the next pass, or given up). */
  failed: number;
  /** Set when Graph throttled a send: the caller pauses until Retry-After elapses (§12). */
  retryAfterSeconds?: number;
}

interface DigestUserRow {
  id: string;
  email: string;
  emailDigest: string | null;
  timeZone: string | null;
  lastRunAt: Date | null;
  failures: number;
}

interface PendingRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  read: boolean;
  skillOk: boolean;
  requestOk: boolean;
  actorErased: boolean;
}

// The "still in digest mode" predicate over `users u`, in SQL: $1 = kill switch, $2 = default mode.
const IN_DIGEST_MODE = `($1::boolean and u.status = 'active' and u.email_notifications and coalesce(u.email, '') <> ''
       and coalesce(u.email_digest, $2::text) in ('daily', 'weekly'))`;

export async function runDigestSweep(
  pool: Pool,
  opts: { email?: EmailTransport; settings: DigestSettings; now?: Date; baseUrl?: string },
): Promise<DigestSweepResult> {
  const { settings } = opts;
  const now = opts.now ?? new Date();
  const baseUrl = opts.baseUrl ?? process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? "";
  const result: DigestSweepResult = { sent: 0, empty: 0, dropped: 0, failed: 0 };

  // 1. Leaving digest mode (forward-only): the waiting rows stay in the inbox, never emailed.
  const left = await pool.query(
    `update notifications n set digest_state = 'dropped'
       from users u
      where u.id = n.user_id and n.digest_state = 'pending' and not ${IN_DIGEST_MODE}`,
    [settings.enabled, settings.defaultMode],
  );
  result.dropped += left.rowCount ?? 0;
  if (!settings.enabled) return result;

  // 2. Digest users who may be due. Slots are at least 23 h apart (a DST day), so a stamp newer
  //    than 22 h can never be before the current slot — skip those without computing it.
  const { rows: users } = await pool.query<DigestUserRow>(
    `select u.id, u.email, u.email_digest as "emailDigest", u.time_zone as "timeZone",
            u.email_digest_last_run_at as "lastRunAt", u.email_digest_failures as failures
       from users u
      where ${IN_DIGEST_MODE}
        and (u.email_digest_last_run_at is null or u.email_digest_last_run_at < $3::timestamptz - interval '22 hours')`,
    [settings.enabled, settings.defaultMode, now],
  );

  for (const user of users) {
    const mode = effectiveDigestMode({ emailNotifications: true, emailDigest: user.emailDigest }, settings);
    if (mode !== "daily" && mode !== "weekly") continue;
    const slot = digestSlot(now, mode, settings.hour, settings.weekday, user.timeZone);
    const due = digestDue(user.lastRunAt, slot);
    if (due === "not_due") continue;
    if (due === "first_sight") {
      await stamp(pool, user, slot);
      continue;
    }

    const pending = await loadPending(pool, user.id);
    // Already seen in-app, or no longer allowed/meaningful → dropped, never emailed.
    const stale = pending.filter((r) => r.read || !r.skillOk || !r.requestOk);
    const keep = pending.filter((r) => !(r.read || !r.skillOk || !r.requestOk));
    // No operational transport at the slot: the digest is not queued (§12, §48.7).
    const toDrop = opts.email ? stale : pending;
    if (toDrop.length) {
      await settle(pool, toDrop.map((r) => r.id), "dropped");
      result.dropped += toDrop.length;
    }
    if (!opts.email || keep.length === 0) {
      await stamp(pool, user, slot);
      if (opts.email) result.empty++;
      continue;
    }

    const rows: DigestRow[] = keep.map((r) => ({
      id: r.id,
      type: r.type,
      // §48.8: an actor erased since the row was created renders as "Deleted User".
      payload: r.actorErased ? { ...r.payload, actorName: "Deleted User" } : r.payload,
      createdAt: r.createdAt,
    }));
    const digest = renderDigest(rows, { mode, baseUrl, bodySentence: notificationBodySentence });
    try {
      await opts.email.send(user.email, { subject: digest.subject, text: digest.text, htmlBody: digest.html, webhook: {} });
    } catch (err) {
      if (err instanceof GraphSendError && err.status === 429) {
        // Throttling is not the digest's fault: no attempt consumed, slot not stamped.
        result.failed++;
        result.retryAfterSeconds = err.retryAfterSeconds ?? 30;
        return result;
      }
      result.failed++;
      if (user.failures + 1 >= MAX_ATTEMPTS) {
        // Give up on this digest: its rows are dropped and the slot closed.
        await settle(pool, keep.map((r) => r.id), "dropped");
        result.dropped += keep.length;
        await stamp(pool, user, slot);
      } else {
        await pool.query(`update users set email_digest_failures = email_digest_failures + 1 where id = $1`, [user.id]);
      }
      console.error(JSON.stringify({ level: "warn", msg: "email digest send failed", attempt: user.failures + 1, err: String((err as Error).message ?? err).slice(0, 300) }));
      continue;
    }
    await settle(pool, keep.map((r) => r.id), "sent");
    await stamp(pool, user, slot);
    result.sent++;
  }
  return result;
}

/** Close the slot (and reset the failure counter) — unless the user changed their choice since we
 *  read them, which reset the stamp to first sight (§48.10) and must win. */
async function stamp(pool: Pool, user: DigestUserRow, slot: Date): Promise<void> {
  await pool.query(
    `update users set email_digest_last_run_at = $2, email_digest_failures = 0
      where id = $1 and email_digest is not distinct from $3`,
    [user.id, slot, user.emailDigest],
  );
}

async function settle(pool: Pool, ids: string[], state: "sent" | "dropped"): Promise<void> {
  await pool.query(`update notifications set digest_state = $2 where id = any($1::uuid[]) and digest_state = 'pending'`, [ids, state]);
}

/**
 * The user's pending rows with the §48.8 re-checks evaluated in SQL: a row naming a skill (proposal
 * rows aside — the proposal's own page governs those) is kept only while the skill exists, is not
 * archived and the user can still see it (the shared per-user visibility predicate, invariant #7);
 * a row naming a request only while the request exists.
 */
async function loadPending(pool: Pool, userId: string): Promise<PendingRow[]> {
  const { rows } = await pool.query<PendingRow>(
    `select n.id, n.type, n.payload, n.created_at as "createdAt", n.read_at is not null as read,
            case when n.type not like 'proposal.%'
                      and (coalesce(n.payload->>'skillId', '') <> '' or coalesce(n.payload->>'skillSlug', '') <> '')
                 then exists (
                   select 1 from skills s join namespaces ns on ns.id = s.namespace_id
                    where (case when coalesce(n.payload->>'skillId', '') <> '' then s.id::text = n.payload->>'skillId'
                                else ns.slug = n.payload->>'namespaceSlug' and s.slug = n.payload->>'skillSlug' end)
                      and s.status = 'active'
                      and ${userCanSeeSkillSql("$1::uuid", "s")})
                 else true end as "skillOk",
            case when coalesce(n.payload->>'requestId', '') <> ''
                 then exists (select 1 from skill_requests r where r.id::text = n.payload->>'requestId')
                 else true end as "requestOk",
            coalesce((select a.erased_at is not null from users a
                       where coalesce(n.payload->>'actorId', '') <> '' and a.id::text = n.payload->>'actorId'), false) as "actorErased"
       from notifications n
      where n.user_id = $1 and n.digest_state = 'pending'
      order by n.created_at`,
    [userId],
  );
  return rows;
}
