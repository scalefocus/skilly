// Live-DB integration test for the contributor leaderboard (SKILLY_SPEC.md §21/§26). Gated by
// SKILLY_DB_E2E=1. Regression focus: ranking must be NUMERIC. The installs output column was once
// cast ::text, and since Postgres binds bare ORDER BY names to output aliases first, the board
// sorted lexicographically — "9" ranked above "12". Seeds two users whose credit counts (9 vs 12)
// diverge under text ordering and asserts numeric descending order on the primary sort and on the
// tie-breaker path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getLeaderboard, LEADERBOARD_LIMIT } from "./leaderboard";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("leaderboard: ranks by installs numerically (9 vs 12), not lexicographically", { skip: !enabled }, async () => {
  try {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('lb-ns','lb-ns',true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;

    const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
      [oid, `${oid}@org`, oid],
    )).rows[0]!.id;
    // Name the 9-credit user alphabetically FIRST so a degenerate name-asc order can't
    // accidentally pass the assertions either.
    const nine = await mkUser("lb-a-nine");
    const twelve = await mkUser("lb-b-twelve");

    const skill = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,'lb-skill','lb-skill','d','claude','hosted','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`, [ns],
    )).rows[0]!.id;

    // Clean prior rows so counts are deterministic across re-runs (credits cascade from access_log).
    await pool.query(`delete from access_log where skill_id = $1`, [skill]);

    // Seed N git installs, each credited to the given maintainer (snapshot rows, §21).
    const credit = (userId: string, n: number) => pool.query(
      `with rows as (
         insert into access_log (actor_user_id, skill_id, source)
         select null, $1, 'git' from generate_series(1, $2::int)
         returning id
       )
       insert into install_credits (access_log_id, user_id) select id, $3 from rows`,
      [skill, n, userId],
    );
    await credit(nine, 9);
    await credit(twelve, 12);

    // bypassCache forces a fresh query past the module-level TTL cache (read our own writes).
    const board = await getLeaderboard("all", "installs", { bypassCache: true });
    assert.ok(board.length <= LEADERBOARD_LIMIT, "board never exceeds the top-100 cap (§21)");
    const mine = board.filter((e) => e.userId === nine || e.userId === twelve);
    assert.equal(mine.length, 2, "both seeded users on the board");
    assert.deepEqual(
      mine.map((e) => e.installs), [12, 9],
      "numeric descending — under text ordering '9' would rank above '12'",
    );
    assert.equal(mine[0]!.userId, twelve);
    for (const e of mine) {
      assert.equal(typeof e.installs, "number", "installs serialized as a number");
      assert.equal(e.skillCount, 1, "one distinct skill behind the credits");
    }

    // Tie-breaker path: both tie on skillCount (=1), so sort=skills must fall back to
    // installs desc — again 12 before 9.
    const bySkills = await getLeaderboard("all", "skills", { bypassCache: true });
    const tied = bySkills.filter((e) => e.userId === nine || e.userId === twelve);
    assert.deepEqual(tied.map((e) => e.userId), [twelve, nine], "skills tie broken by installs desc");

    // cleanup (install_credits cascade with access_log; users/namespace stay, upsert-idempotent)
    await pool.query(`delete from access_log where skill_id = $1`, [skill]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  } finally {
    await pool.end();
  }
});
