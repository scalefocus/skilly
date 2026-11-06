// Live-DB integration test for the visit-day prune (SKILLY_SPEC.md §67.5).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: rows older than the 28-day Visits window (day < today − 27, UTC) are deleted, while the
// window itself — today back to today − 27 — is kept intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneVisitDays } from "../visits.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("visit-day prune: keeps the 28-day window, deletes everything older", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const user = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, status) values ('visit-prune-oid', 'visit-prune@org', 'Visit prune', 'active')
       on conflict (entra_object_id) do update set status = 'active' returning id`,
    )).rows[0]!.id;
    await pool.query(`delete from user_visit_days where user_id = $1`, [user]);
    // today, today − 27 (the oldest kept day), today − 28 and today − 60 (both pruned)
    await pool.query(
      `insert into user_visit_days (user_id, day)
       select $1, (now() at time zone 'utc')::date - g from unnest(array[0, 27, 28, 60]) g`,
      [user],
    );

    const deleted = await pruneVisitDays(pool);
    assert.ok(deleted >= 2, `at least this test's two old rows went (deleted ${deleted})`);

    const kept = (await pool.query<{ ago: number }>(
      `select ((now() at time zone 'utc')::date - day)::int as ago from user_visit_days where user_id = $1 order by ago`,
      [user],
    )).rows.map((r) => r.ago);
    assert.deepEqual(kept, [0, 27]);

    await pool.query(`delete from user_visit_days where user_id = $1`, [user]);
  } finally {
    await pool.end();
  }
});
