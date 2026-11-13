// Live-DB integration test for plugin deliveries (SKILLY_SPEC.md §21 "Plugin deliveries are not
// adoption", §30.7). Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates, through the worker's own code paths:
//   - the gateway's marketplace credit (pgGitDeps.creditMarketplaceFetch) records each delivered
//     skill as REACH: an access_log row flagged is_plugin, install_count +1, a DELIVERED-ONLY ledger
//     row and no maintainer credit; Bulk Buyer and Hello, Skill are still awarded;
//   - the Skills-you-might-like rebuild (recomputeRelatedSkills) pairs skills by ADOPTED rows only,
//     so a marketplace that delivers two skills to the same people does not make them related.
// Fixtures use a run-unique slug prefix; assertions read only those rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pgGitDeps } from "../git/pgDeps.js";
import { recomputeRelatedSkills } from "../related.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("plugin deliveries: the marketplace credit path is reach, not adoption; related skills read adoptions only", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const tag = `pdw${Date.now().toString(36)}`;

  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name) values ($1, $1 || '@org.test', $1)
       on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
      [oid],
    );
  const ns = await one(
    `insert into namespaces (slug, display_name, require_review) values ('pdw-ns', 'pdw-ns', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  );
  const maint = await mkUser("pdw-maint");
  const subscriber = await mkUser(`${tag}-sub`);
  const others = [await mkUser(`${tag}-o1`), await mkUser(`${tag}-o2`)];
  const mkSkill = (slug: string) =>
    one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'generic', 'hosted', 'org', 'active') returning id`,
      [ns, slug],
    );
  const a = await mkSkill(`${tag}-a`);
  const b = await mkSkill(`${tag}-b`);
  const c = await mkSkill(`${tag}-c`);
  const skills = [a, b, c];
  for (const s of skills) await q(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [s, maint]);

  try {
    // ── The marketplace credit path ────────────────────────────────────────────────────────────
    const deps = pgGitDeps(pool);
    const credited = await deps.creditMarketplaceFetch({
      tokenId: randomUUID(), // no such token row: the cursor update is a no-op
      userId: subscriber,
      scope: { kind: "public" },
      namespaceId: null,
      slugs: [`${tag}-a`, `${tag}-b`],
      newCommit: "0".repeat(40),
    });
    assert.equal(credited, 2);

    const access = await q<{ skill_id: string; is_plugin: boolean; credits: number }>(
      `select al.skill_id, al.is_plugin,
              (select count(*)::int from install_credits ic where ic.access_log_id = al.id) as credits
         from access_log al where al.actor_user_id = $1 and al.skill_id = any($2::uuid[]) order by al.skill_id`,
      [subscriber, skills],
    );
    assert.equal(access.rows.length, 2, "one access_log row per delivered skill");
    for (const r of access.rows) {
      assert.equal(r.is_plugin, true, "flagged as a plugin delivery");
      assert.equal(r.credits, 0, "no maintainer credit");
    }
    const ledger = await q<{ skill_id: string; adopted_at: Date | null }>(
      `select skill_id, adopted_at from skill_installs where user_id = $1 and skill_id = any($2::uuid[])`,
      [subscriber, skills],
    );
    assert.equal(ledger.rows.length, 2, "the subscriber holds both skills");
    for (const r of ledger.rows) assert.equal(r.adopted_at, null, "delivered only");
    const counts = await q<{ id: string; install_count: number }>(
      `select id, install_count::int from skills where id = any($1::uuid[])`, [[a, b]],
    );
    for (const r of counts.rows) assert.equal(r.install_count, 1, "install_count still counts the holder");
    const badges = await q<{ key: string }>(
      `select key from user_achievements where user_id = $1 and key in ('first_marketplace', 'first_install') order by key`,
      [subscriber],
    );
    assert.deepEqual(badges.rows.map((r) => r.key), ["first_install", "first_marketplace"], "Bulk Buyer and Hello, Skill");

    // ── Skills you might like: adopted rows only ───────────────────────────────────────────────
    // Two other people deliberately adopt A and C; the subscriber holds A and B only by plugin.
    for (const u of others) {
      await q(`select record_git_access($1, $2)`, [a, u]);
      await q(`select record_git_access($1, $2)`, [c, u]);
    }
    assert.ok((await recomputeRelatedSkills(pool)) >= 0, "the rebuild ran");
    const related = await q<{ skill_id: string; related_skill_id: string; shared_count: number }>(
      `select skill_id, related_skill_id, shared_count::int from related_skills
        where skill_id = any($1::uuid[]) and related_skill_id = any($1::uuid[]) order by skill_id, related_skill_id`,
      [skills],
    );
    const pairs = related.rows.map((r) => `${r.skill_id === a ? "a" : r.skill_id === b ? "b" : "c"}>${r.related_skill_id === a ? "a" : r.related_skill_id === b ? "b" : "c"}:${r.shared_count}`);
    assert.deepEqual(pairs.sort(), ["a>c:2", "c>a:2"], "A and C are related by two adopters; B (delivered only) relates to nothing");
  } finally {
    await q(`delete from related_skills where skill_id = any($1::uuid[]) or related_skill_id = any($1::uuid[])`, [skills]);
    await q(`delete from access_log where skill_id = any($1::uuid[])`, [skills]);
    await q(`delete from skills where id = any($1::uuid[])`, [skills]);
    await pool.end();
  }
});
