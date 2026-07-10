// Notification center reads (web). Rows are written on governance events (see proposals.ts)
// and delivered externally by the worker; this is the in-app inbox. SKILLY_SPEC.md §12.
import { pool } from "./db";

export interface NotificationView {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  /** The skill the event concerns, resolved for display (so the inbox names the skill,
   *  not just the event type). Null when it can't be resolved (e.g. a deleted proposal). */
  skillTitle: string | null;
  skillSlug: string | null;
  namespaceSlug: string | null;
}

export async function listNotifications(userId: string, limit = 100, offset = 0, types?: string[]): Promise<NotificationView[]> {
  // Optional type filter — server-side because the inbox paginates (filtering only the
  // loaded page client-side would silently miss matches beyond it).
  const filtered = types !== undefined && types.length > 0;
  const params: unknown[] = [userId, Math.min(200, limit), Math.max(0, offset)];
  if (filtered) params.push(types);
  // Resolve which skill each notification is about, so the inbox can show its NAME:
  //  - proposal.* rows carry `proposalId` → resolve via the proposal (handles brand-new
  //    skills that don't exist yet, by reading the latest revision's metadata);
  //  - skill.* rows carry `namespaceSlug`/`skillSlug` → resolve straight from skills.
  // Proposal resolution wins when both apply (it knows the exact namespace).
  const { rows } = await pool.query<{
    id: string; type: string; payload: Record<string, unknown>; read_at: string | null; created_at: string;
    skill_title: string | null; skill_slug: string | null; namespace_slug: string | null;
  }>(
    `select n.id, n.type, n.payload, n.read_at, n.created_at,
            coalesce(vp.title, vs.title) as skill_title,
            coalesce(vp.slug,  vs.slug)  as skill_slug,
            coalesce(vp.ns,    vs.ns)    as namespace_slug
       from notifications n
       left join lateral (
         select coalesce(s.title, pr.payload->'metadata'->>'title')    as title,
                coalesce(s.slug,  pr.payload->'metadata'->>'skillSlug') as slug,
                pn.slug as ns
           from proposals p
           left join skills s on s.id = p.target_skill_id
           left join namespaces pn on pn.id = p.target_namespace_id
           left join lateral (
             select payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1
           ) pr on true
          where p.id = nullif(n.payload->>'proposalId', '')::uuid
       ) vp on (n.payload ? 'proposalId')
       left join lateral (
         select s.title, s.slug, sn.slug as ns
           from skills s join namespaces sn on sn.id = s.namespace_id
          where s.slug = n.payload->>'skillSlug'
            and (n.payload->>'namespaceSlug' is null or sn.slug = n.payload->>'namespaceSlug')
          limit 1
       ) vs on (n.payload ? 'skillSlug')
      where n.user_id = $1 ${filtered ? "and n.type = any($4)" : ""}
      order by n.created_at desc limit $2 offset $3`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, type: r.type, payload: r.payload, readAt: r.read_at, createdAt: r.created_at,
    skillTitle: r.skill_title, skillSlug: r.skill_slug, namespaceSlug: r.namespace_slug,
  }));
}

/**
 * Cap a user's notification history at the most recent `keep` rows, deleting older ones to
 * bound storage. Called when the inbox is loaded (§12). Keeps EXACTLY the newest `keep`
 * (created_at desc, id as a deterministic tiebreak) and deletes the rest — a no-op for users
 * under the cap. The kept set is the newest page, so it's safe to run concurrently with a read.
 */
export async function pruneNotifications(userId: string, keep = 1000): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from notifications
      where user_id = $1
        and id not in (
          select id from notifications
           where user_id = $1
           order by created_at desc, id desc
           limit $2
        )`,
    [userId, keep],
  );
  return rowCount ?? 0;
}

export async function unreadCount(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from notifications where user_id = $1 and read_at is null`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Mark specific notifications read, or all of the user's unread when `ids` is omitted. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length > 0) {
    const { rowCount } = await pool.query(
      `update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[]) and read_at is null`,
      [userId, ids],
    );
    return rowCount ?? 0;
  }
  const { rowCount } = await pool.query(
    `update notifications set read_at = now() where user_id = $1 and read_at is null`,
    [userId],
  );
  return rowCount ?? 0;
}
