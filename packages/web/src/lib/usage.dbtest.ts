// Live-DB integration test for the usage dashboard (SKILLY_SPEC.md §21). Gated by SKILLY_DB_E2E=1.
// Validates window bucketing (24h/30d/all), entitlement scoping (platform admin / namespace
// admin / maintainer / member), the platform-vs-namespace aggregate, and the per-skill
// drill-down incl. the anonymous (tokenless) install bucket.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { getUsageDashboard, getBreakdown } from "./usage";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("usage dashboard: windows + entitlement + aggregate + breakdown", { skip: !enabled }, async () => {
  try {
    const ns = async (slug: string) => (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1,$1,true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`, [slug],
    )).rows[0]!.id;
    const nsA = await ns("usage-ns");
    const nsB = await ns("usage-ns2");

    const mkUser = async (oid: string) => (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
      [oid, `${oid}@org`, oid],
    )).rows[0]!.id;
    const viewer1 = await mkUser("usage-viewer1");
    const viewer2 = await mkUser("usage-viewer2");
    const installer1 = await mkUser("usage-installer1");
    const maint = await mkUser("usage-maint");
    const member = await mkUser("usage-member");

    const mkSkill = async (nsId: string, slug: string) => (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,$2,$2,'d','claude','hosted','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`, [nsId, slug],
    )).rows[0]!.id;
    const skillA = await mkSkill(nsA, "usage-a");
    const skillB = await mkSkill(nsA, "usage-b");
    const skillC = await mkSkill(nsB, "usage-c");
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [skillB, maint]);

    // Clean any prior rows for these skills so counts are deterministic across re-runs.
    await pool.query(`delete from usage_events where skill_id = any($1::uuid[])`, [[skillA, skillB, skillC]]);
    await pool.query(`delete from access_log where skill_id = any($1::uuid[])`, [[skillA, skillB, skillC]]);

    // Views on skillA: viewer1 x2 (now, -2h), viewer2 x1 (now), viewer1 x1 (-40d → all only).
    const view = (s: string, n: string, u: string, ago: string) =>
      pool.query(`insert into usage_events (skill_id, namespace_id, actor_user_id, created_at) values ($1,$2,$3, now() - $4::interval)`, [s, n, u, ago]);
    await view(skillA, nsA, viewer1, "0 hours");
    await view(skillA, nsA, viewer1, "2 hours");
    await view(skillA, nsA, viewer2, "0 hours");
    await view(skillA, nsA, viewer1, "40 days");
    await view(skillB, nsA, viewer1, "0 hours");

    // Installs (git clones) on skillA: installer1 x2 (now, -2h) + 1 anonymous (now). skillC: 1.
    const inst = (s: string, u: string | null, ago: string) =>
      pool.query(`insert into access_log (actor_user_id, skill_id, source, created_at) values ($1,$2,'git', now() - $3::interval)`, [u, s, ago]);
    await inst(skillA, installer1, "0 hours");
    await inst(skillA, installer1, "2 hours");
    await inst(skillA, null, "0 hours");
    await inst(skillC, installer1, "0 hours");
    // A SYSTEM-installation clone (§23): actorless + is_system — bucketed apart from anonymous.
    await pool.query(
      `insert into access_log (actor_user_id, skill_id, source, is_system, created_at) values (null, $1, 'git', true, now())`,
      [skillA],
    );

    const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
    const nsAdmin: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[nsA, "namespace_admin"]]) };
    const maintainer: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
    const plainMember: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

    // Platform admin: sees every skill + a platform aggregate; per-skill windows are exact.
    const padmin = await getUsageDashboard(platform, installer1);
    assert.equal(padmin.aggregate?.scope, "platform");
    const a = padmin.skills.find((s) => s.skillSlug === "usage-a")!;
    assert.ok(a, "skillA present for platform admin");
    assert.deepEqual([a.views.d1, a.views.d30, a.views.all], [3, 3, 4], "view windows");
    assert.deepEqual([a.installs.d1, a.installs.all], [4, 4], "install windows (incl. anonymous + system)");
    assert.ok(padmin.skills.some((s) => s.skillSlug === "usage-c"), "platform admin sees other namespace");

    // Daily series (§21 "Graphs"): default 30 buckets, aligned axis; the fresh events land in
    // the last two buckets (the "-2h" rows may straddle midnight); the 40-day-old view is
    // outside the charted range entirely.
    const last2 = (arr: number[]) => arr.slice(-2).reduce((x, y) => x + y, 0);
    assert.equal(padmin.seriesDays.length, 30, "default 30-day axis");
    assert.equal(a.daily.views.length, 30);
    assert.equal(last2(a.daily.views), 3, "recent view buckets (40d-old view excluded)");
    assert.equal(a.daily.views.reduce((x, y) => x + y, 0), 3, "charted views exclude the 40d-old row");
    assert.equal(last2(a.daily.installs), 4, "recent install buckets (incl. anonymous + system)");
    assert.ok(last2(padmin.aggregate!.series.installs) >= 5, "platform series sums all skills (A:4 + C:1)");
    // 7-day range: shorter axis, same recent buckets.
    const p7 = await getUsageDashboard(platform, installer1, 7);
    assert.equal(p7.seriesDays.length, 7);
    assert.equal(last2(p7.skills.find((s) => s.skillSlug === "usage-a")!.daily.installs), 4);

    // Namespace admin of nsA: sees nsA skills, NOT skillC; aggregate scoped to namespace.
    const nadmin = await getUsageDashboard(nsAdmin, viewer1);
    assert.equal(nadmin.aggregate?.scope, "namespace");
    assert.ok(nadmin.skills.some((s) => s.skillSlug === "usage-a") && nadmin.skills.some((s) => s.skillSlug === "usage-b"));
    assert.ok(!nadmin.skills.some((s) => s.skillSlug === "usage-c"), "ns admin does NOT see other namespace (#3)");

    // Maintainer (no admin role): sees ONLY the skill they maintain, no aggregate.
    const md = await getUsageDashboard(maintainer, maint);
    assert.equal(md.aggregate, null, "maintainer gets no aggregate");
    assert.deepEqual(md.skills.map((s) => s.skillSlug), ["usage-b"], "maintainer sees only maintained skill");

    // Member with nothing: empty.
    const mem = await getUsageDashboard(plainMember, member);
    assert.equal(mem.aggregate, null);
    assert.equal(mem.skills.length, 0, "member sees nothing");

    // Drill-down for skillA (all time): named installer + anonymous bucket; viewers ranked.
    const nowIso = new Date().toISOString();
    const bdAll = await getBreakdown(skillA, nowIso, "all");
    assert.equal(bdAll.anonymousInstalls, 1, "1 anonymous (tokenless) install — system clone NOT counted here");
    assert.equal(bdAll.systemInstalls, 1, "1 System install clone in its own bucket");
    assert.equal(bdAll.installers.find((i) => i.email === "usage-installer1@org")?.count, 2);
    assert.equal(bdAll.viewers.find((v) => v.email === "usage-viewer1@org")?.count, 3);
    // 7d window excludes the 40-day-old viewer1 view.
    const bd7 = await getBreakdown(skillA, nowIso, "7d");
    assert.equal(bd7.viewers.find((v) => v.email === "usage-viewer1@org")?.count, 2);

    // cleanup (access_log delete needs superuser, which the test connection is)
    await pool.query(`delete from usage_events where skill_id = any($1::uuid[])`, [[skillA, skillB, skillC]]);
    await pool.query(`delete from access_log where skill_id = any($1::uuid[])`, [[skillA, skillB, skillC]]);
    await pool.query(`delete from skill_maintainers where skill_id = any($1::uuid[])`, [[skillA, skillB, skillC]]);
    await pool.query(`delete from skills where id = any($1::uuid[])`, [[skillA, skillB, skillC]]);
  } finally {
    await pool.end();
  }
});
