// Live-DB integration test for skill ratings (SKILLY_SPEC.md §18). Gated behind SKILLY_DB_E2E=1.
//
//   start pg + apply db/migrations (0001 … 0012)
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates: the rollup trigger keeps skills.rating_sum/rating_count correct across
// insert / update (delta) / revoke / cascade-on-deprovision, the 1-5 CHECK constraint,
// and that getRating() aggregates average + distribution + the caller's own rating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRating, setRating, clearRating } from "./ratings";
import { searchSkills } from "./catalog";
import { pool } from "./db";
import type { EffectiveAccess } from "@skilly/shared";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("skill ratings: rollup trigger + aggregation + cascade", { skip: !enabled }, async () => {
  try {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('rate-ns','Rate NS', false)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const skill = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,'rated-skill','Rated','d','claude','hosted','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns],
    )).rows[0]!.id;
    await pool.query(`delete from skill_ratings where skill_id = $1`, [skill]); // idempotent reset

    const u: string[] = [];
    for (let i = 0; i < 3; i++) {
      u.push((await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name) values ($1,$2,'U')
         on conflict (entra_object_id) do update set email = excluded.email returning id`,
        [`rate-u${i}`, `u${i}@org`],
      )).rows[0]!.id);
    }
    const agg = async () => (await pool.query<{ s: string; c: string }>(
      `select rating_sum::text s, rating_count::text c from skills where id = $1`, [skill])).rows[0]!;

    // INSERT 5,3,4 → sum 12 / count 3
    await setRating(u[0]!, skill, 5, "1.0.0");
    await setRating(u[1]!, skill, 3, "1.0.0");
    await setRating(u[2]!, skill, 4, null);
    assert.deepEqual(await agg(), { s: "12", c: "3" }, "after insert");

    // UPDATE (upsert) u1 3→1, delta −2 → sum 10 / count unchanged
    await setRating(u[1]!, skill, 1, "1.0.0");
    assert.deepEqual(await agg(), { s: "10", c: "3" }, "after update delta");

    // getRating: avg 10/3, count 3, distribution [1★:1, 4★:1, 5★:1], mine(u0)=5
    const r = await getRating(skill, u[0]!);
    assert.equal(r.count, 3);
    assert.equal(r.mine, 5);
    assert.ok(Math.abs(r.avg - 10 / 3) < 1e-9, "avg");
    assert.deepEqual(r.distribution, [1, 0, 0, 1, 1], "distribution");

    // REVOKE u0 (was 5) → sum 5 / count 2
    await clearRating(u[0]!, skill);
    assert.deepEqual(await agg(), { s: "5", c: "2" }, "after revoke");

    // CASCADE: deprovision u2 (was 4) → row removed, trigger recomputes → sum 1 / count 1
    await pool.query(`delete from users where id = $1`, [u[2]!]);
    assert.deepEqual(await agg(), { s: "1", c: "1" }, "after cascade delete");

    // null caller → mine null, count still 1
    const anon = await getRating(skill, null);
    assert.equal(anon.mine, null);
    assert.equal(anon.count, 1);

    // CHECK constraint rejects out-of-range stars
    await assert.rejects(
      pool.query(`insert into skill_ratings (user_id, skill_id, stars) values ($1,$2,6)`, [u[1]!, skill]),
      /violates check constraint/i,
      "stars=6 rejected",
    );

    // Bayesian "top_rated" ranking (§18): a well-rated skill outranks a poorly-rated one.
    const mkSkill = async (slug: string) => (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,$2,$2,'d','claude','hosted','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns, slug],
    )).rows[0]!.id;
    const high = await mkSkill("rank-high");
    const low = await mkSkill("rank-low");
    for (const s of [high, low]) await pool.query(`delete from skill_ratings where skill_id = $1`, [s]);
    await setRating(u[0]!, high, 5, null);
    await setRating(u[1]!, high, 5, null);
    await setRating(u[0]!, low, 2, null);
    await setRating(u[1]!, low, 2, null);

    const admin: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
    const ranked = await searchSkills(admin, { sort: "top_rated", limit: 100 });
    const hi = ranked.findIndex((r) => r.skillSlug === "rank-high");
    const lo = ranked.findIndex((r) => r.skillSlug === "rank-low");
    assert.ok(hi >= 0 && lo >= 0, "both ranked skills visible");
    assert.ok(hi < lo, "higher-rated skill ranks above lower-rated under top_rated sort");

    // cleanup
    for (const s of [skill, high, low]) {
      await pool.query(`delete from skill_ratings where skill_id = $1`, [s]);
      await pool.query(`delete from skills where id = $1`, [s]);
    }
    await pool.query(`delete from users where entra_object_id like 'rate-u%'`);
    await pool.query(`delete from namespaces where slug = 'rate-ns'`);
  } finally {
    await pool.end();
  }
});
