// Usage insights (SKILLY_SPEC.md §68): the server half shared by the web tier (the ingest endpoint,
// the key surfaces, the dashboard) and the worker (housekeeping). Node-only (crypto) — never
// imported by client code.
//
// Privacy by construction (§68.5–§68.6): a hit row holds the UTC day, the skill, the version, the
// trigger, HMAC-SHA256(day salt, user id) and SHA-256(event id). No timestamp, no user id, no
// session, no IP. The day comes from the database clock in the same statement, and a salt is only
// ever created for today. The §62 search-gap model, with its own salt table.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Queryable } from "./search.js";
import { generateToken } from "./tokens.js";
import { USAGE_TRIGGERS, type UsageReport, type UsageTrigger } from "./usage-hook.js";

/** SHA-256 (bytes) of a raw usage key — the only form it is stored in (§68.4). */
export function usageKeyHash(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/** HMAC-SHA256(salt, user id) — the only form a reporter is ever stored in (§68.5). */
export function usageReporterHash(salt: Buffer, userId: string): Buffer {
  return createHmac("sha256", salt).update(userId, "utf8").digest();
}

/** SHA-256 of the hook's opaque event id — folds the dual-plugin duplicate (§68.3). */
export function usageEventHash(eventId: string): Buffer {
  return createHash("sha256").update(eventId, "utf8").digest();
}

/** Narrow an untrusted request body to a report, or null (§68.5: 400 on shape errors). */
export function parseUsageReport(body: unknown): UsageReport | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const skillId = typeof b.skillId === "string" ? b.skillId.trim() : "";
  const semver = typeof b.semver === "string" ? b.semver.trim() : "";
  const trigger = typeof b.trigger === "string" ? b.trigger : "";
  const eventId = typeof b.eventId === "string" ? b.eventId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(skillId)) return null;
  if (!semver || semver.length > 64) return null;
  if (!(USAGE_TRIGGERS as readonly string[]).includes(trigger)) return null;
  if (!eventId || eventId.length > 128) return null;
  return { skillId: skillId.toLowerCase(), semver, trigger: trigger as UsageTrigger, eventId };
}

// ---------------------------------------------------------------------------
// Keys (§68.4) — one per user, hashed at rest, no expiry
// ---------------------------------------------------------------------------

export interface UsageKeyState {
  createdAt: string;
  lastUsedAt: string | null;
}

/** The caller's key state, or null when they do not share usage. */
export async function getUsageKeyState(db: Queryable, userId: string): Promise<UsageKeyState | null> {
  const { rows } = await db.query(`select created_at, last_used_at from usage_report_keys where user_id = $1`, [userId]);
  const r = rows[0] as { created_at: Date; last_used_at: Date | null } | undefined;
  return r ? { createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null } : null;
}

/** Mint the caller's key. Null when they already hold one (the caller answers 409). */
export async function mintUsageKey(db: Queryable, userId: string): Promise<{ raw: string; createdAt: string } | null> {
  const raw = generateToken(32);
  const { rows } = await db.query(
    `insert into usage_report_keys (user_id, key_hash) values ($1, $2) on conflict (user_id) do nothing returning created_at`,
    [userId, usageKeyHash(raw)],
  );
  const r = rows[0] as { created_at: Date } | undefined;
  return r ? { raw, createdAt: r.created_at.toISOString() } : null;
}

/** Delete + mint in one statement: the old key stops working the moment the new one exists. */
export async function regenerateUsageKey(db: Queryable, userId: string): Promise<{ raw: string; createdAt: string }> {
  const raw = generateToken(32);
  const { rows } = await db.query(
    `insert into usage_report_keys (user_id, key_hash) values ($1, $2)
     on conflict (user_id) do update set key_hash = excluded.key_hash, created_at = now(), last_used_at = null
     returning created_at`,
    [userId, usageKeyHash(raw)],
  );
  return { raw, createdAt: (rows[0] as { created_at: Date }).created_at.toISOString() };
}

/** Stop sharing: the row is gone, the next report is refused. True when a row was deleted. */
export async function deleteUsageKey(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query(`with d as (delete from usage_report_keys where user_id = $1 returning 1) select count(*)::int as n from d`, [userId]);
  return (rows[0] as { n: number }).n > 0;
}

/**
 * Resolve a presented key to its owner — only while the owner is `active` and not erased (§68.4).
 * Null for anything else; the endpoint answers the same 401 for every reason.
 */
export async function findUsageKeyOwner(db: Queryable, raw: string): Promise<{ userId: string } | null> {
  if (!raw || raw.length > 128) return null;
  const { rows } = await db.query(
    `select k.user_id from usage_report_keys k join users u on u.id = k.user_id
      where k.key_hash = $1 and u.status = 'active' and u.erased_at is null`,
    [usageKeyHash(raw)],
  );
  const r = rows[0] as { user_id: string } | undefined;
  return r ? { userId: r.user_id } : null;
}

/** `last_used_at`, stamped at most once a minute per key (§68.4). Best-effort. */
export async function touchUsageKey(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `update usage_report_keys set last_used_at = now()
      where user_id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Hits (§68.5)
// ---------------------------------------------------------------------------

// Today's salt may be cached in memory, keyed by the day, and is dropped when the day changes.
let saltCache: { day: string; salt: Buffer } | null = null;

/** Test hook: forget the in-memory salt. */
export function resetUsageSaltCache(): void {
  saltCache = null;
}

async function todaysSalt(db: Queryable): Promise<{ day: string; salt: Buffer }> {
  const { rows } = await db.query(`select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as day`);
  const day = (rows[0] as { day: string }).day;
  if (saltCache?.day === day) return saltCache;
  await db.query(
    // Only ever for the current day (§62.2 precedent): a statement that crosses midnight creates
    // nothing for a day housekeeping may already have folded.
    `insert into skill_usage_salts (day, salt)
     select $1::date, $2 where $1::date = (now() at time zone 'UTC')::date
     on conflict (day) do nothing`,
    [day, randomBytes(32)],
  );
  const r = await db.query(`select salt from skill_usage_salts where day = $1::date`, [day]);
  const salt = (r.rows[0] as { salt: Buffer } | undefined)?.salt;
  if (!salt) throw new Error("usage salt missing");
  saltCache = { day, salt };
  return saltCache;
}

export type UsageRecordOutcome = "recorded" | "duplicate" | "dropped";

/**
 * Store one use. The caller has already resolved the key's owner and checked that the owner may
 * see the skill (invariant #3); this checks that the skill exists and that `semver` names one of
 * its versions (any status — it bounds the cardinality a client can create), then writes the hit.
 * A conflict is a duplicate (the same event reported by two plugins, or a client retry).
 */
export async function recordUsageHit(db: Queryable, input: UsageReport & { userId: string }): Promise<UsageRecordOutcome> {
  const { rows } = await db.query(`select 1 from skill_versions where skill_id = $1 and semver = $2`, [input.skillId, input.semver]);
  if (rows.length === 0) return "dropped";
  const { day, salt } = await todaysSalt(db);
  const res = await db.query(
    `insert into skill_usage_hits (day, skill_id, semver, trigger, reporter_hash, event_hash)
     values ($1::date, $2, $3, $4, $5, $6)
     on conflict do nothing returning 1`,
    [day, input.skillId, input.semver, input.trigger, usageReporterHash(salt, input.userId), usageEventHash(input.eventId)],
  );
  return res.rows.length > 0 ? "recorded" : "duplicate";
}

/** Read the switch (absent ⇒ off) — one indexed row, no cache (§68.8). */
export async function usageInsightsEnabled(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(`select value from platform_settings where key = 'usage_insights_enabled'`);
  return (rows[0] as { value?: unknown } | undefined)?.value === true;
}

// ---------------------------------------------------------------------------
// Housekeeping (§68.6) — fold finished days, delete their hits and salts
// ---------------------------------------------------------------------------

/**
 * Fold every finished UTC day's hits into `skill_usage_daily` (uses + distinct people) and
 * `skill_usage_daily_detail` (uses per version and trigger), then delete those hits and the day's
 * salt — one transaction, whatever the switch says. Daily rows are kept forever. `begin`/`commit`
 * need a dedicated client (pg PoolClient).
 */
export async function foldSkillUsageDays(client: Queryable): Promise<{ foldedDays: number }> {
  await client.query("begin");
  try {
    const today = `(now() at time zone 'UTC')::date`;
    const days = await client.query(
      `select count(distinct day)::int as n from (
         select day from skill_usage_hits where day < ${today}
         union select day from skill_usage_salts where day < ${today}) d`,
    );
    await client.query(
      `insert into skill_usage_daily (day, skill_id, uses, people)
       select day, skill_id, count(*)::int, count(distinct reporter_hash)::int
         from skill_usage_hits where day < ${today}
        group by day, skill_id
       on conflict (day, skill_id) do update
         set uses = skill_usage_daily.uses + excluded.uses,
             people = skill_usage_daily.people + excluded.people`,
    );
    await client.query(
      `insert into skill_usage_daily_detail (day, skill_id, semver, trigger, uses)
       select day, skill_id, semver, trigger, count(*)::int
         from skill_usage_hits where day < ${today}
        group by day, skill_id, semver, trigger
       on conflict (day, skill_id, semver, trigger) do update
         set uses = skill_usage_daily_detail.uses + excluded.uses`,
    );
    await client.query(`delete from skill_usage_hits where day < ${today}`);
    await client.query(`delete from skill_usage_salts where day < ${today}`);
    await client.query("commit");
    return { foldedDays: (days.rows[0] as { n: number }).n };
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}
