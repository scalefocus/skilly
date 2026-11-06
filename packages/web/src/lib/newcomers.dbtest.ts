// Live-DB integration test for the new-user map behind the hat (SKILLY_SPEC.md §66.3) and for
// migration 0107's backfill (§66.7). Gated by SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/newcomers.dbtest.ts
//
// Covers: a user whose first visit is within 30 days is listed; opted-out, inactive, erased,
// older-than-30-day and never-seen users are not; the switch-off path returns an empty list; and
// re-running migration 0107 backfills first_seen = created_at only for live users who have visited,
// without moving visits_since. The platform switch itself is passed in, not toggled here — the card
// tests own that global key (directory.dbtest.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getNewcomers, invalidateNewcomers } from "./newcomers";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

async function mk(
  oid: string,
  opts: { firstSeenDaysAgo: number | null; status?: "active" | "inactive"; hidden?: boolean; erased?: boolean },
): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $1 || '@org', $1)
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [oid],
  )).rows[0]!.id;
  await pool.query(
    `update users set status = $2, directory_hidden = $3, erased_at = case when $4 then now() else null end,
            first_seen = case when $5::int is null then null else now() - make_interval(days => $5::int) end
      where id = $1`,
    [id, opts.status ?? "active", opts.hidden ?? false, opts.erased ?? false, opts.firstSeenDaysAgo],
  );
  return id;
}

test("newcomers: only active, visible people within 30 days of their first visit", { skip: !enabled }, async () => {
  const fresh = await mk("newcomer-fresh", { firstSeenDaysAgo: 5 });
  const edge = await mk("newcomer-29", { firstSeenDaysAgo: 29 });
  const old = await mk("newcomer-31", { firstSeenDaysAgo: 31 });
  const hidden = await mk("newcomer-hidden", { firstSeenDaysAgo: 5, hidden: true });
  const inactive = await mk("newcomer-inactive", { firstSeenDaysAgo: 5, status: "inactive" });
  const erased = await mk("newcomer-erased", { firstSeenDaysAgo: 5, erased: true });
  const never = await mk("newcomer-never", { firstSeenDaysAgo: null });
  try {
    invalidateNewcomers();
    const { ids } = await getNewcomers(true);
    assert.ok(ids.includes(fresh), "a 5-day-old first visit is new");
    assert.ok(ids.includes(edge), "29 days is still new");
    for (const [label, id] of [["31 days", old], ["opted out", hidden], ["inactive", inactive], ["erased", erased], ["never seen", never]] as const) {
      assert.ok(!ids.includes(id), `${label} is not listed`);
    }

    // Switched off: empty, whatever the data says.
    assert.deepEqual(await getNewcomers(false), { ids: [] });

    // The map is cached; invalidation makes an opt-out show at once.
    await pool.query(`update users set directory_hidden = true where id = $1`, [fresh]);
    invalidateNewcomers();
    assert.ok(!(await getNewcomers(true)).ids.includes(fresh), "an opt-out leaves the map after invalidation");
  } finally {
    await pool.query(`update users set erased_at = null where id = $1`, [erased]); // leave the fixture reusable
    invalidateNewcomers();
  }
});

test("migration 0107: backfills first_seen from created_at for live visited users; visits_since never moves", { skip: !enabled }, async () => {
  const visited = await mk("backfill-visited", { firstSeenDaysAgo: null });
  const neverSeen = await mk("backfill-never", { firstSeenDaysAgo: null });
  const tombstone = await mk("backfill-erased", { firstSeenDaysAgo: null, erased: true });
  await pool.query(
    `update users set created_at = '2024-03-01T10:00:00Z', last_seen = now() - interval '1 day' where id = any($1::uuid[])`,
    [[visited, tombstone]],
  );
  await pool.query(`update users set last_seen = null where id = $1`, [neverSeen]);
  const sinceBefore = (await pool.query<{ value: unknown }>(`select value from platform_settings where key = 'visits_since'`)).rows[0]?.value;
  try {
    // The migration is idempotent by construction (IF NOT EXISTS, a NULL-only backfill, ON CONFLICT
    // DO NOTHING), so re-running the shipped file exercises its backfill against these fixtures.
    const sql = readFileSync(resolve(process.cwd(), "../../db/migrations/0107_visit_days.sql"), "utf8");
    await pool.query(sql);

    const firstSeen = async (id: string) =>
      (await pool.query<{ first_seen: Date | null }>(`select first_seen from users where id = $1`, [id])).rows[0]!.first_seen;
    assert.equal((await firstSeen(visited))?.toISOString(), "2024-03-01T10:00:00.000Z");
    assert.equal(await firstSeen(neverSeen), null, "never visited stays NULL");
    assert.equal(await firstSeen(tombstone), null, "an erased tombstone stays NULL");

    const sinceAfter = (await pool.query<{ value: unknown }>(`select value from platform_settings where key = 'visits_since'`)).rows[0]?.value;
    if (sinceBefore !== undefined) assert.deepEqual(sinceAfter, sinceBefore, "a re-run never moves visits_since");
    else assert.match(String(sinceAfter), /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await pool.query(`update users set erased_at = null where id = $1`, [tombstone]);
  }
});
