// Live-DB integration test for the contributor leaderboard (SKILLY_SPEC.md §21/§26). Gated by
// SKILLY_DB_E2E=1. Regression focus: ranking must be NUMERIC. The installs output column was once
// cast ::text, and since Postgres binds bare ORDER BY names to output aliases first, the board
// sorted lexicographically — "9" ranked above "12". Seeds two users whose credit counts (9 vs 12)
// diverge under text ordering and asserts numeric descending order on the primary sort and on the
// tie-breaker path. A second test covers the "skills requested" stat (§26), a third the three
// adoption doors behind installs received, and a fourth the installer's own "skills installed".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordAgentClone } from "@skilly/shared";
import { getLeaderboard, LEADERBOARD_LIMIT } from "./leaderboard";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

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
    /* pool closed in after() */
  }
});

test("leaderboard: 'skills requested' counts open + fulfilled by requester, windowed on created_at (§26)", { skip: !enabled }, async () => {
  const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  // Alphabetically the 3-request user sorts LAST so a degenerate name-asc order can't pass.
  const one = await mkUser("lbrq-a-one");
  const three = await mkUser("lbrq-b-three");
  const mkReq = (requester: string, title: string, state: "open" | "fulfilled", ageDays: number) => pool.query(
    `insert into skill_requests (requester_user_id, title, description, state, created_at)
     values ($1, $2, 'd', $3, now() - ($4::int * interval '1 day'))`,
    [requester, title, state, ageDays],
  );
  await pool.query(`delete from skill_requests where title like 'lbrq %'`);
  try {
    // three: two recent (one open, one fulfilled) + one 40 days old → 3 all-time, 2 in 30d.
    await mkReq(three, "lbrq t1", "open", 1);
    await mkReq(three, "lbrq t2", "fulfilled", 2);
    await mkReq(three, "lbrq t3", "open", 40);
    // one: a single 40-day-old request → 1 all-time, 0 in 30d (drops off the 30d board entirely).
    await mkReq(one, "lbrq o1", "open", 40);

    const all = await getLeaderboard("all", "requested", { bypassCache: true });
    const mine = all.filter((e) => e.userId === one || e.userId === three);
    assert.deepEqual(mine.map((e) => [e.userId, e.skillsRequested]), [[three, 3], [one, 1]],
      "pure requesters appear on the board; open AND fulfilled count; ranked desc");
    for (const e of mine) {
      assert.equal(typeof e.skillsRequested, "number");
      assert.equal(e.installs, 0, "no install credit — this person only asks");
    }

    const recent = await getLeaderboard("30d", "requested", { bypassCache: true });
    const threeRecent = recent.find((e) => e.userId === three);
    assert.equal(threeRecent?.skillsRequested, 2, "30d window keys on the request's created_at");
    assert.equal(recent.find((e) => e.userId === one), undefined, "nothing in the window → not on the 30d board");

    // Hard-deleting a request (withdraw/remove, §26) drops the count immediately — no snapshot.
    await pool.query(`delete from skill_requests where title = 'lbrq t1'`);
    const afterDelete = await getLeaderboard("all", "requested", { bypassCache: true });
    assert.equal(afterDelete.find((e) => e.userId === three)?.skillsRequested, 2);
  } finally {
    await pool.query(`delete from skill_requests where title like 'lbrq %'`);
  }
});

// Regression: the board once joined access_log on source = 'git', so a credit written by a first
// DOWNLOAD or a first MCP READ was never counted — and never could be, because the shared
// skill_installs ledger stops a later clone by the same person from crediting again. Drives the
// three real recorders rather than seeding rows, so the test follows whatever they write.
test("leaderboard: a first adoption credits the maintainer through every door — clone, download, MCP read (§21/§29)", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('lb-ns','lb-ns',true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  const maint = await mkUser("lb-door-maint");
  const cloner = await mkUser("lb-door-clone");
  const downloader = await mkUser("lb-door-download");
  const reader = await mkUser("lb-door-mcp");

  const skill = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
     values ($1,'lb-door-skill','lb-door-skill','d','claude','hosted','org')
     on conflict (namespace_id, slug) do update set title = excluded.title returning id`, [ns],
  )).rows[0]!.id;

  // Read our own writes past the TTL cache; the assertions only ever look at the maintainer's row.
  const credited = async (window: "all" | "30d" = "all") => {
    const row = (await getLeaderboard(window, "installs", { bypassCache: true })).find((e) => e.userId === maint);
    return { installs: row?.installs ?? 0, skillCount: row?.skillCount ?? 0 };
  };

  try {
    // Deterministic across re-runs: no prior adoptions of this skill (credits cascade from access_log).
    await pool.query(`delete from access_log where skill_id = $1`, [skill]);
    await pool.query(`delete from skill_installs where skill_id = $1`, [skill]);
    await pool.query(`delete from skill_maintainers where skill_id = $1`, [skill]);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [skill, maint]);

    await pool.query(`select record_git_access($1, $2, false, false)`, [skill, cloner]);
    assert.deepEqual(await credited(), { installs: 1, skillCount: 1 }, "a first clone credits the maintainer");

    await pool.query(`select record_skill_download($1, $2)`, [skill, downloader]);
    assert.deepEqual(await credited(), { installs: 2, skillCount: 1 }, "a first download credits the maintainer");

    await pool.query(`select record_mcp_read($1, $2)`, [skill, reader]);
    assert.deepEqual(await credited(), { installs: 3, skillCount: 1 }, "a first MCP read credits the maintainer");

    assert.deepEqual(await credited("30d"), { installs: 3, skillCount: 1 }, "the 30d window counts every door too");

    // Three doors, one fact: the same people coming back through a different door add nothing.
    await pool.query(`select record_git_access($1, $2, false, false)`, [skill, downloader]);
    await pool.query(`select record_git_access($1, $2, false, false)`, [skill, reader]);
    await pool.query(`select record_skill_download($1, $2)`, [skill, cloner]);
    await pool.query(`select record_mcp_read($1, $2)`, [skill, cloner]);
    assert.deepEqual(await credited(), { installs: 3, skillCount: 1 }, "a repeat adoption through another door never re-credits");

    // No self-credit, whichever door the maintainer uses on their own skill.
    await pool.query(`select record_skill_download($1, $2)`, [skill, maint]);
    assert.deepEqual(await credited(), { installs: 3, skillCount: 1 }, "a maintainer adopting their own skill earns nothing");
  } finally {
    // install_credits cascade with access_log; skill_installs/skill_maintainers go with the skill.
    await pool.query(`delete from access_log where skill_id = $1`, [skill]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  }
});

// §21 "Skills installed": the one number about what a person installs THEMSELVES — their rows in
// the skill_installs ledger. Drives the real recorders (and the agent-key recorder, which must not
// count). Every assertion reads only this test's own users: the other DB test files run in parallel
// against this database, and the board is capped at the top 100, so the two installers get counts
// (6 and 4) well above what any other file's fixtures reach.
test("leaderboard: 'skills installed' counts a person's own first adoptions, own skills included (§21)", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('lb-ns','lb-ns',true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
     on conflict (entra_object_id) do update set email = excluded.email, leaderboard_hidden = false returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  const maint = await mkUser("lbsi-maint");
  // The 4-install user sorts alphabetically FIRST, so a degenerate name-asc order can't pass.
  const solo = await mkUser("lbsi-a-solo");
  const keen = await mkUser("lbsi-b-keen");

  const skills: string[] = [];
  for (let i = 0; i < 6; i++) {
    skills.push((await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1, $2, $2, 'd', 'claude', 'hosted', 'org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`, [ns, `lbsi-s${i}`],
    )).rows[0]!.id);
  }
  const own = skills[5]!; // maintained by keen alone
  const clean = async () => {
    await pool.query(`delete from access_log where skill_id = any($1::uuid[])`, [skills]);
    await pool.query(`delete from skill_installs where skill_id = any($1::uuid[])`, [skills]);
    await pool.query(`delete from agent_installs where skill_id = any($1::uuid[])`, [skills]);
    await pool.query(`delete from skill_maintainers where skill_id = any($1::uuid[])`, [skills]);
  };
  const clone = (skill: string, user: string | null, system = false) =>
    pool.query(`select record_git_access($1, $2, $3, $3)`, [skill, user, system]);
  // The two installers' rows on the Installed board, in board order, as [userId, skillsInstalled].
  const installed = async (window: "all" | "30d" = "all") =>
    (await getLeaderboard(window, "installed", { bypassCache: true }))
      .filter((e) => e.userId === keen || e.userId === solo)
      .map((e) => [e.userId, e.skillsInstalled]);

  try {
    await clean();
    await pool.query(
      `insert into skill_maintainers (skill_id, user_id) select unnest($1::uuid[]), $2`, [skills.slice(0, 5), maint],
    );
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [own, keen]);

    // keen: six skills through all three doors, one of them their own.
    await clone(skills[0]!, keen);
    await pool.query(`select record_skill_download($1, $2)`, [skills[1], keen]);
    await pool.query(`select record_mcp_read($1, $2)`, [skills[2], keen]);
    await clone(skills[3]!, keen);
    await clone(skills[4]!, keen);
    await clone(own, keen);
    // solo: four clones.
    for (const s of skills.slice(0, 4)) await clone(s, solo);

    assert.deepEqual(await installed(), [[keen, 6], [solo, 4]], "one per skill, every door, own skill included; ranked desc");

    // A person whose only standing is having installed skills is on the board, with 0 elsewhere.
    const soloRow = (await getLeaderboard("all", "installed", { bypassCache: true })).find((e) => e.userId === solo)!;
    assert.equal(typeof soloRow.skillsInstalled, "number");
    assert.deepEqual(
      [soloRow.installs, soloRow.skillCount, soloRow.requestsFulfilled, soloRow.skillsWatched, soloRow.skillsRequested, soloRow.followers, soloRow.collections],
      [0, 0, 0, 0, 0, 0, 0],
    );

    // Independent of installs received: the same first installs credited the maintainer of s0–s4
    // (5 by keen + 4 by solo), while keen's install of their own skill credited nobody.
    const received = await getLeaderboard("all", "installs", { bypassCache: true });
    const maintRow = received.find((e) => e.userId === maint)!;
    assert.deepEqual([maintRow.installs, maintRow.skillCount, maintRow.skillsInstalled], [9, 5, 0]);
    assert.equal((await getLeaderboard("all", "installed", { bypassCache: true })).find((e) => e.userId === keen)!.installs, 0, "no self-credit, unchanged");

    // Repeat clones and a second door on an adopted skill change nothing.
    await clone(skills[0]!, keen);
    await pool.query(`select record_skill_download($1, $2)`, [skills[0], keen]);
    await pool.query(`select record_mcp_read($1, $2)`, [skills[3], solo]);
    assert.deepEqual(await installed(), [[keen, 6], [solo, 4]], "re-installing never re-counts");

    // Not counted: a system installation (no user) and an agent-key clone (no ledger row).
    await clone(skills[1]!, null, true);
    await recordAgentClone(pool, { userId: solo, skillId: skills[4]!, userAgent: "git/2.45.0", clientIp: "10.9.9.9" });
    assert.deepEqual(await installed(), [[keen, 6], [solo, 4]], "system and agent-key clones are outside the ledger");

    // 30d keys on first_at: two of keen's adoptions and all of solo's are older than the window.
    await pool.query(
      `update skill_installs set first_at = now() - interval '40 days' where user_id = $1 and skill_id = any($2::uuid[])`,
      [keen, skills.slice(0, 2)],
    );
    await pool.query(`update skill_installs set first_at = now() - interval '40 days' where user_id = $1`, [solo]);
    assert.deepEqual(await installed("30d"), [[keen, 4]], "nothing in the window → not on the 30d board");
    assert.deepEqual(await installed(), [[keen, 6], [solo, 4]], "all-time is unaffected by age");

    // The leaderboard opt-out hides the whole row, this number included.
    await pool.query(`update users set leaderboard_hidden = true where id = $1`, [solo]);
    assert.deepEqual(await installed(), [[keen, 6]]);
    await pool.query(`update users set leaderboard_hidden = false where id = $1`, [solo]);

    // A hard-deleted skill takes its ledger rows with it (cascade), so the count drops.
    await pool.query(`delete from access_log where skill_id = $1`, [own]);
    await pool.query(`delete from skills where id = $1`, [own]);
    assert.deepEqual(await installed(), [[keen, 5], [solo, 4]]);
  } finally {
    await pool.query(`update users set leaderboard_hidden = false where id = $1`, [solo]);
    // install_credits cascade with access_log; skill_installs, agent_installs and skill_maintainers
    // go with the skills.
    await pool.query(`delete from access_log where skill_id = any($1::uuid[])`, [skills]);
    await pool.query(`delete from skills where id = any($1::uuid[])`, [skills]);
  }
});
