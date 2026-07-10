// System-log alerting (SKILLY_SPEC.md §25): coalesced bell notifications to platform admins when
// new system_event rows appear. Leader-only sweep (called from index.ts).
//
// A per-event fan-out would flood the inbox during an incident, so we COALESCE: at most one unread
// `system.error` notification per admin, whose count accumulates until the admin reads it. A
// platform_settings watermark (`system_log_notify_at`) records how far we've notified so events are
// never double-counted. In-app only (delivered_at stamped now) — no email/webhook fan-out for these.
import type { Pool } from "pg";

const WATERMARK_KEY = "system_log_notify_at";

/** Returns the number of admins notified this sweep (0 when there's nothing new). */
export async function notifyNewSystemEvents(pool: Pool): Promise<number> {
  const wm = await pool.query<{ value: string }>(
    `select value::text as value from platform_settings where key = $1`,
    [WATERMARK_KEY],
  );
  const watermark: string = wm.rows[0]?.value ? JSON.parse(wm.rows[0].value) : "1970-01-01T00:00:00Z";

  const agg = await pool.query<{ n: string; latest: string | null }>(
    `select count(*)::text as n, max(created_at)::text as latest
       from system_event where created_at > $1::timestamptz`,
    [watermark],
  );
  const n = Number(agg.rows[0]?.n ?? 0);
  const latest = agg.rows[0]?.latest;
  if (n === 0 || !latest) return 0;

  // Platform admins = active users in any group mapped to the platform_admin role.
  const admins = await pool.query<{ id: string }>(
    `select distinct u.id
       from users u
       join group_memberships gm on gm.user_id = u.id
       join role_mappings rm on rm.group_id = gm.group_id
      where rm.role = 'platform_admin' and u.status = 'active'`,
  );

  for (const a of admins.rows) {
    // Coalesce: bump the existing unread alert's count so it accumulates until read; otherwise
    // create one. Keeping (not replacing) the existing row preserves delivered_at, and new rows
    // are stamped delivered so the external delivery sweep leaves system alerts in-app only.
    const upd = await pool.query(
      `update notifications
          set payload = jsonb_set(payload, '{count}', to_jsonb(coalesce((payload->>'count')::int, 0) + $2)),
              created_at = now()
        where user_id = $1 and type = 'system.error' and read_at is null`,
      [a.id, n],
    );
    if ((upd.rowCount ?? 0) === 0) {
      await pool.query(
        `insert into notifications (user_id, type, payload, delivered_at)
         values ($1, 'system.error', $2::jsonb, now())`,
        [a.id, JSON.stringify({ count: n })],
      );
    }
  }

  // Advance the watermark to the newest event now accounted for.
  await pool.query(
    `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [WATERMARK_KEY, latest],
  );

  return admins.rows.length;
}
