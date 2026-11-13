// Live-DB integration test for plugin deliveries (SKILLY_SPEC.md §21 "Plugin deliveries are not
// adoption", migration 0111). Gated by SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/pluginDeliveries.dbtest.ts
//
// Test 1 drives the three recorders: a plugin delivery is reach (install_count, a flagged access_log
// row, a delivered-only ledger row) and never adoption (no credit, not on the leaderboard); a later
// clone, download or MCP read adopts it and credits the maintainers without a second install_count;
// adopted-then-delivered stays adopted; the usage holders line; Skills you might like.
//
// Test 2 runs the recount (recount_plugin_deliveries, scoped to its own users) over hand-made
// history: same-instant bursts, lone deliveries after a person's marketplace start, token-proven
// clones, a Bulk Buyer start, a download-origin row, and a later deliberate clone to recover.
//
// Every fixture is unique to the run; assertions read only those rows (the DB test files run in
// parallel on one database).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { getLeaderboard } from "./leaderboard";
import { getBreakdown } from "./usage";
import { relatedSkills } from "./catalog";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
const mkUser = (oid: string) =>
  one(
    `insert into users (entra_object_id, email, display_name) values ($1, $1 || '@org.test', $1)
     on conflict (entra_object_id) do update set status = 'active', erased_at = null, leaderboard_hidden = false returning id`,
    [oid],
  );
const mkNs = () =>
  one(`insert into namespaces (slug, display_name, require_review) values ('pdl-ns', 'pdl-ns', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`);
// No versions: the recorders and the related-skills read need none, and a skill with a version
// cannot be deleted afterwards (versions are immutable).
const mkSkill = async (ns: string, slug: string, maintainer: string) => {
  const id = await one(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1, $2, $2, 'd', 'generic', 'hosted', 'org', 'active') returning id`,
    [ns, slug],
  );
  await q(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [id, maintainer]);
  return id;
};
const cleanup = async (skills: string[], users: string[]) => {
  await q(`delete from related_skills where skill_id = any($1::uuid[]) or related_skill_id = any($1::uuid[])`, [skills]);
  await q(`delete from tokens where skill_id = any($1::uuid[])`, [skills]);
  // install_credits cascade with access_log; skill_installs and skill_maintainers go with the skills.
  await q(`delete from access_log where skill_id = any($1::uuid[]) or actor_user_id = any($2::uuid[])`, [skills, users]);
  await q(`delete from user_achievements where user_id = any($1::uuid[])`, [users]);
  await q(`delete from skills where id = any($1::uuid[])`, [skills]);
};

test("plugin deliveries: reach, not adoption; a later deliberate install adopts (§21)", { skip: !enabled }, async () => {
  const tag = `pdl${Date.now().toString(36)}`;
  const ns = await mkNs();
  const maint = await mkUser(`${tag}-maint`);
  const sub = await mkUser(`${tag}-sub`); // plugin, then a clone
  const dl = await mkUser(`${tag}-dl`); // plugin, then a download
  const mcp = await mkUser(`${tag}-mcp`); // plugin, then an MCP read
  const early = await mkUser(`${tag}-early`); // a clone, then plugin
  const viewer = await mkUser(`${tag}-viewer`);
  const users = [maint, sub, dl, mcp, early, viewer];
  const s = await mkSkill(ns, `${tag}-s`, maint);
  const t = await mkSkill(ns, `${tag}-t`, maint);
  const skills = [s, t];

  const deliver = (skill: string, user: string) => q(`select record_git_access($1, $2, false, false, true)`, [skill, user]);
  const clone = (skill: string, user: string) => q(`select record_git_access($1, $2)`, [skill, user]);
  const ledger = async (user: string, skill = s) =>
    (await q<{ adopted_at: Date | null; first_at: Date }>(`select adopted_at, first_at from skill_installs where user_id = $1 and skill_id = $2`, [user, skill])).rows[0];
  const installCount = async (skill = s) => (await q<{ n: number }>(`select install_count::int as n from skills where id = $1`, [skill])).rows[0]!.n;
  const credits = async () =>
    (await q<{ n: number }>(`select count(*)::int as n from install_credits ic join access_log al on al.id = ic.access_log_id where al.skill_id = $1`, [s])).rows[0]!.n;
  const board = async (window: "all" | "30d" = "all") => {
    const installed = await getLeaderboard(window, "installed", { bypassCache: true });
    const received = await getLeaderboard(window, "installs", { bypassCache: true });
    const mine = (id: string) => installed.find((e) => e.userId === id)?.skillsInstalled ?? 0;
    return { sub: mine(sub), dl: mine(dl), mcp: mine(mcp), early: mine(early), maint: mine(maint), maintReceived: received.find((e) => e.userId === maint)?.installs ?? 0 };
  };

  try {
    // ── A plugin delivery is reach ─────────────────────────────────────────────────────────────
    await deliver(s, sub);
    assert.equal((await ledger(sub))?.adopted_at, null, "held, delivered only");
    assert.equal(await installCount(), 1, "install_count counts the holder");
    assert.equal(await credits(), 0, "no maintainer credit");
    const flagged = await q<{ is_plugin: boolean }>(`select is_plugin from access_log where actor_user_id = $1 and skill_id = $2`, [sub, s]);
    assert.deepEqual(flagged.rows.map((r) => r.is_plugin), [true], "the access_log row is flagged");
    assert.deepEqual(await board(), { sub: 0, dl: 0, mcp: 0, early: 0, maint: 0, maintReceived: 0 }, "nothing on the leaderboard");
    const created = (await q<{ created_at: string }>(`select created_at::text from skills where id = $1`, [s])).rows[0]!.created_at;
    assert.deepEqual((await getBreakdown(s, created, "all")).holders, { total: 1, pluginOnly: 1 });

    // A second delivery (a new version) adds activity, not a holder.
    await deliver(s, sub);
    assert.equal(await installCount(), 1);
    assert.equal((await ledger(sub))?.adopted_at, null);

    // ── A later deliberate clone adopts it ─────────────────────────────────────────────────────
    await clone(s, sub);
    const subRow = await ledger(sub);
    assert.ok(subRow?.adopted_at instanceof Date, "adopted now");
    assert.ok(subRow!.adopted_at!.getTime() >= subRow!.first_at.getTime());
    assert.equal(await installCount(), 1, "still one person");
    assert.equal(await credits(), 1, "the maintainer is credited for the deliberate install");
    assert.deepEqual(await board(), { sub: 1, dl: 0, mcp: 0, early: 0, maint: 0, maintReceived: 1 });
    // Its 30-day window reads adopted_at: delivered 60 days ago, adopted today ⇒ in the window.
    await q(`update skill_installs set first_at = now() - interval '60 days' where user_id = $1 and skill_id = $2`, [sub, s]);
    assert.equal((await board("30d")).sub, 1, "the window reads adopted_at, not first_at");

    // ── A download and an MCP read adopt a delivered skill too ─────────────────────────────────
    await deliver(s, dl);
    assert.equal(await installCount(), 2);
    assert.equal((await q<{ ok: boolean }>(`select record_skill_download($1, $2) as ok`, [s, dl])).rows[0]!.ok, true, "the download adopts");
    assert.ok((await ledger(dl))?.adopted_at instanceof Date);
    assert.equal(await installCount(), 2, "no second install_count");
    assert.equal((await q<{ ok: boolean }>(`select record_skill_download($1, $2) as ok`, [s, dl])).rows[0]!.ok, false, "a repeat download is a no-op");
    await deliver(s, mcp);
    assert.equal((await q<{ ok: boolean }>(`select record_mcp_read($1, $2) as ok`, [s, mcp])).rows[0]!.ok, true, "the MCP read adopts");
    assert.ok((await ledger(mcp))?.adopted_at instanceof Date);
    assert.equal(await installCount(), 3);
    assert.equal(await credits(), 3, "one credit per adoption, through each door");
    const doors = await q<{ source: string }>(
      `select al.source from install_credits ic join access_log al on al.id = ic.access_log_id where al.skill_id = $1 order by al.source`,
      [s],
    );
    assert.deepEqual(doors.rows.map((r) => r.source), ["download", "git", "mcp_resource"]);

    // ── Adopted first, delivered later: stays adopted, with its original date ──────────────────
    await clone(s, early);
    const before = (await ledger(early))!.adopted_at!.getTime();
    await deliver(s, early);
    assert.equal((await ledger(early))!.adopted_at!.getTime(), before, "unchanged");
    assert.equal(await credits(), 4, "the delivery wrote no credit");
    assert.equal(await installCount(), 4);

    // ── The maintainer: a delivered, then cloned, own skill counts for them, with no self-credit ─
    await deliver(s, maint);
    await clone(s, maint);
    assert.ok((await ledger(maint))?.adopted_at instanceof Date);
    assert.equal(await credits(), 4, "no self-credit");
    assert.deepEqual(await board(), { sub: 1, dl: 1, mcp: 1, early: 1, maint: 1, maintReceived: 4 });
    assert.deepEqual((await getBreakdown(s, created, "all")).holders, { total: 5, pluginOnly: 0 });

    // ── Skills you might like: a neighbour held only by plugin is still suggested ──────────────
    await q(`insert into related_skills (skill_id, related_skill_id, shared_count) values ($1, $2, 3)`, [s, t]);
    const access: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
    await deliver(t, viewer);
    const r1 = await relatedSkills(access, s, viewer);
    assert.deepEqual(r1.related.map((e) => e.skillId), [t], "held by plugin only ⇒ suggested");
    await clone(t, viewer);
    const r2 = await relatedSkills(access, s, viewer);
    assert.deepEqual(r2.related, [], "adopted ⇒ left out");
    assert.equal(r2.allInstalled, true);
  } finally {
    await cleanup(skills, users);
  }
});

test("migration 0111 recount: bursts, lone deliveries after a marketplace start, token proof, recovery (§21)", { skip: !enabled }, async () => {
  const tag = `pdr${Date.now().toString(36)}`;
  const ns = await mkNs();
  const maint = await mkUser(`${tag}-maint`);
  const u1 = await mkUser(`${tag}-plain`); // never had a marketplace
  const u2 = await mkUser(`${tag}-burst`); // a burst, a lone delivery, a proven clone, a recovery
  const u3 = await mkUser(`${tag}-bulk`); // Bulk Buyer only
  const u4 = await mkUser(`${tag}-dl`); // a subscriber whose row came from a download
  const users = [maint, u1, u2, u3, u4];
  const sk: string[] = [];
  for (let i = 1; i <= 5; i++) sk.push(await mkSkill(ns, `${tag}-s${i}`, maint));
  const [s1, s2, s3, s4, s5] = sk as [string, string, string, string, string];
  // One base instant for the whole test, so every `at(n)` names the same moment each time it is used.
  const base = Math.floor(Date.now() / 1000) * 1000;
  const at = (days: number, ms = 0) => new Date(base - days * 86_400_000 + ms);

  // History as the old recorders wrote it: an access_log row, the ledger row (adopted_at = first_at,
  // what step 1 starts from) and, for a first adoption, a credit for the maintainer.
  const history = async (user: string, skill: string, when: Date, o: { source?: string; first?: boolean } = {}) => {
    const id = await one(
      `insert into access_log (actor_user_id, skill_id, source, created_at) values ($1, $2, $3, $4) returning id`,
      [user, skill, o.source ?? "git", when],
    );
    if (o.first !== false) {
      await q(`insert into skill_installs (skill_id, user_id, first_at, adopted_at) values ($1, $2, $3, $3)`, [skill, user, when]);
      await q(`insert into install_credits (access_log_id, user_id) values ($1, $2)`, [id, maint]);
    }
    return id;
  };
  const installToken = (user: string, skill: string, usedAt: Date) =>
    q(
      `insert into tokens (user_id, type, hashed_token, skill_id, scope, used_at, is_system)
       values ($1, 'install', $2, $3, '{}'::jsonb, $4, false)`,
      [user, `${tag}-${user}-${skill}-${Math.random()}`, skill, usedAt],
    );
  const state = async () => {
    const rows = await q<{ user_id: string; skill_id: string; adopted_at: Date | null }>(
      `select user_id, skill_id, adopted_at from skill_installs where skill_id = any($1::uuid[])`, [sk],
    );
    const name = new Map([[u1, "plain"], [u2, "burst"], [u3, "bulk"], [u4, "dl"]]);
    const skill = new Map(sk.map((id, i) => [id, `s${i + 1}`]));
    return Object.fromEntries(rows.rows.map((r) => [`${name.get(r.user_id)}:${skill.get(r.skill_id)}`, r.adopted_at ? r.adopted_at.toISOString() : null]));
  };
  const creditsOn = async () =>
    (await q<{ user_id: string; skill_id: string; created_at: Date }>(
      `select al.actor_user_id as user_id, al.skill_id, al.created_at
         from install_credits ic join access_log al on al.id = ic.access_log_id
        where al.skill_id = any($1::uuid[]) order by al.created_at`,
      [sk],
    )).rows.length;

  try {
    // u1: two ordinary clones, no marketplace trace ⇒ untouched.
    await history(u1, s1, at(10));
    await history(u1, s2, at(9));

    // u2: a burst of three at one instant (20 days ago) ⇒ deliveries.
    const burst = at(20);
    for (const s of [s1, s2, s3]) await history(u2, s, burst);
    // A lone delivery after the start, with no install token ⇒ a delivery.
    await history(u2, s4, at(15));
    // A deliberate clone proven by an install token ⇒ stays adopted.
    await history(u2, s5, at(12));
    await installToken(u2, s5, at(12));
    // A later deliberate clone of s1 (delivered in the burst), proven by its token; the old recorder
    // wrote no ledger change and no credit for it ⇒ recovered.
    await history(u2, s1, at(5), { first: false });
    await installToken(u2, s1, at(5, 500));

    // u3: Bulk Buyer 8 days ago; a lone clone before it stays, one after it (no token) is a delivery.
    await q(`insert into user_achievements (user_id, key, earned_at) values ($1, 'first_marketplace', $2)`, [u3, at(8)]);
    await history(u3, s1, at(10));
    await history(u3, s2, at(6));

    // u4: a subscriber whose row came from a download ⇒ not a git row, stays adopted.
    await q(`insert into user_achievements (user_id, key, earned_at) values ($1, 'first_marketplace', $2)`, [u4, at(30)]);
    await history(u4, s3, at(4), { source: "download" });

    // u1 2 + u2 5 (burst 3, lone 1, proven 1) + u3 2 + u4 1; u2's later s1 clone was not a first adoption.
    assert.equal(await creditsOn(), 10, "fixture: ten first adoptions credited the maintainer");

    const totals = (await q<{ t: Record<string, unknown> }>(`select recount_plugin_deliveries($1::uuid[]) as t`, [[u1, u2, u3, u4]])).rows[0]!.t;
    assert.deepEqual(totals, { accessRowsFlagged: 5, ledgerRowsReclassified: 5, creditsRemoved: 5, adoptionsRecovered: 1, scope: "users" });

    const after1 = await state();
    assert.equal(after1["plain:s1"], at(10).toISOString());
    assert.equal(after1["plain:s2"], at(9).toISOString());
    assert.equal(after1["burst:s1"], at(5).toISOString(), "recovered: adopted at the later deliberate clone");
    assert.equal(after1["burst:s2"], null);
    assert.equal(after1["burst:s3"], null);
    assert.equal(after1["burst:s4"], null, "a lone delivery after the start");
    assert.equal(after1["burst:s5"], at(12).toISOString(), "a token-proven clone");
    assert.equal(after1["bulk:s1"], at(10).toISOString(), "before the Bulk Buyer start");
    assert.equal(after1["bulk:s2"], null, "after the Bulk Buyer start, with no token");
    assert.equal(after1["dl:s3"], at(4).toISOString(), "a download is never a delivery");

    // Credits: 10 − 5 removed + 1 recovered = 6; the recovered one hangs off the later clone.
    assert.equal(await creditsOn(), 6);
    const recovered = await q<{ n: number }>(
      `select count(*)::int as n from install_credits ic join access_log al on al.id = ic.access_log_id
        where al.actor_user_id = $1 and al.skill_id = $2 and al.created_at = $3 and ic.user_id = $4`,
      [u2, s1, at(5), maint],
    );
    assert.equal(recovered.rows[0]!.n, 1, "today's maintainer is credited for the recovered adoption");
    const flaggedCount = (await q<{ n: number }>(`select count(*)::int as n from access_log where is_plugin and actor_user_id = any($1::uuid[])`, [users])).rows[0]!.n;
    assert.equal(flaggedCount, 5);

    const audit = await q<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'leaderboard.plugin_recount' and after->>'scope' = 'users'
        and (after->>'adoptionsRecovered')::int = 1 and (after->>'accessRowsFlagged')::int = 5 order by created_at desc limit 1`,
    );
    assert.equal(audit.rows.length, 1, "audited with the totals");

    // Running it again changes nothing.
    await q(`select recount_plugin_deliveries($1::uuid[])`, [[u1, u2, u3, u4]]);
    assert.deepEqual(await state(), after1);
    assert.equal(await creditsOn(), 6);

    // The app role may run the recorders but never the recount.
    const priv = (await q<{ app: boolean | null }>(
      `select case when exists (select 1 from pg_roles where rolname = 'skilly_app')
                   then has_function_privilege('skilly_app', 'recount_plugin_deliveries(uuid[])', 'execute') end as app`,
    )).rows[0]!.app;
    if (priv !== null) assert.equal(priv, false);
  } finally {
    await cleanup(sk, users);
  }
});
