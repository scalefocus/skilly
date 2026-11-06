// Live-DB integration test for "Popular in your department" (SKILLY_SPEC.md §66.9). Gated by
// SKILLY_DB_E2E=1. Verifies: the 90-day window and the floor of 2, trimmed case-insensitive
// matching (and a different department not matching), who counts (inactive / erased / opted-out
// colleagues and system installations don't), the viewer's own adoptions left out, visibility
// (restricted hidden, a §42 grant shown), eligibility (archived / deprecated / no live version),
// the order with each tie-break and the cap of 6, the heading label, the no-department and
// switch-off cases, the audited switch, and the cache (step 1 reused, step 2 live).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { departmentPopular, resetDepartmentPopularCache } from "./departmentPopular";
import { setDepartmentPopularEnabled } from "./settings";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("popular in your department: window, floor, matching, who counts, filters, order, cap, switch, cache", { skip: !enabled }, async () => {
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

  // One fixed clock for the whole test, so "the same day" really is the same instant.
  const base = Date.now();
  const now = new Date(base);
  const at = (daysAgo: number) => new Date(base - daysAgo * 86_400_000);

  const mkNs = (slug: string) =>
    one(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [slug],
    );
  const ns = await mkNs("deptpop-ns");
  const otherNs = await mkNs("deptpop-other");

  // Fixed users, reset to a known state each run (audit_log FK — never deleted).
  const mkUser = (oid: string, department: string | null, o: { status?: "active" | "inactive"; erased?: boolean; hidden?: boolean } = {}) =>
    one(
      `insert into users (entra_object_id, email, display_name, status, department, directory_hidden, erased_at)
       values ($1, $1 || '@org', $1, $2, $3, $4, case when $5 then now() else null end)
       on conflict (entra_object_id) do update set status = excluded.status, department = excluded.department,
         directory_hidden = excluded.directory_hidden, erased_at = excluded.erased_at returning id`,
      [oid, o.status ?? "active", department, o.hidden ?? false, o.erased ?? false],
    );
  const admin = await mkUser("deptpop-admin", null);
  const viewer = await mkUser("deptpop-viewer", "DeptPop Eng");
  const viewer2 = await mkUser("deptpop-viewer2", "  DEPTPOP eng ");
  const c1 = await mkUser("deptpop-c1", "DeptPop Eng");
  const c2 = await mkUser("deptpop-c2", " deptpop eng ");
  const c3 = await mkUser("deptpop-c3", "DEPTPOP ENG");
  const c4 = await mkUser("deptpop-c4", "DeptPop Eng");
  const ops = await mkUser("deptpop-ops", "DeptPop Eng Ops");
  const inactive = await mkUser("deptpop-inactive", "DeptPop Eng", { status: "inactive" });
  const erased = await mkUser("deptpop-erased", "DeptPop Eng", { erased: true });
  const hidden = await mkUser("deptpop-hidden", "DeptPop Eng", { hidden: true });
  const noDept = await mkUser("deptpop-nodept", null);
  const blankDept = await mkUser("deptpop-blank", "   ");

  // A clean slate for this test's skills: no adoptions, no grants.
  await q(`delete from skill_installs where skill_id in (select id from skills where namespace_id = any($1::uuid[]))`, [[ns, otherNs]]);
  await q(`delete from skill_namespace_grants where skill_id in (select id from skills where namespace_id = any($1::uuid[]))`, [[ns, otherNs]]);

  const mkSkill = async (
    slug: string,
    o: { title?: string; nsId?: string; visibility?: "org" | "namespace"; status?: "active" | "archived"; installCount?: number; deprecated?: boolean; installable?: boolean } = {},
  ) => {
    const id = await one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status, install_count)
       values ($1, $2, $3, 'd', 'claude', 'hosted', $4, $5, $6)
       on conflict (namespace_id, slug) do update set title = excluded.title, visibility = excluded.visibility,
         status = excluded.status, install_count = excluded.install_count,
         deprecated_at = null, deprecated_by = null, successor_skill_id = null, deprecation_note = null returning id`,
      [o.nsId ?? ns, slug, o.title ?? slug, o.visibility ?? "org", o.status ?? "active", o.installCount ?? 10],
    );
    if (o.deprecated) await q(`update skills set deprecated_at = now(), deprecated_by = $2 where id = $1`, [id, admin]);
    await q(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1, '1.0.0', false, 'active', 'k/deptpop', 'h', $2, $3)
       on conflict (skill_id, semver) do update set status = 'active', git_published = excluded.git_published`,
      [id, admin, o.installable ?? true],
    );
    return id;
  };
  const adopt = (skillId: string, userId: string, daysAgo: number) =>
    q(
      `insert into skill_installs (skill_id, user_id, first_at) values ($1, $2, $3)
       on conflict (skill_id, user_id) do update set first_at = excluded.first_at`,
      [skillId, userId, at(daysAgo)],
    );

  // — The ranked set (expected order R1..R6; R7 falls past the cap of 6) —
  const r1 = await mkSkill("deptpop-r1");
  for (const [u, d] of [[c1, 10], [c2, 12], [c3, 14], [c4, 16]] as const) await adopt(r1, u, d);
  const r2 = await mkSkill("deptpop-r2");
  for (const [u, d] of [[c1, 5], [c2, 6], [c3, 7]] as const) await adopt(r2, u, d);
  const r3 = await mkSkill("deptpop-r3"); // 3 colleagues like R2, but an older latest adoption
  for (const [u, d] of [[c1, 20], [c2, 21], [c3, 22]] as const) await adopt(r3, u, d);
  const r4 = await mkSkill("deptpop-r4", { installCount: 50 }); // ties R5/R6 on count + date; more installs
  const r5 = await mkSkill("deptpop-r5", { title: "DeptPop R5 alpha" }); // ties R6 on installs; title first
  const r6 = await mkSkill("deptpop-r6", { title: "DeptPop R6 beta" });
  for (const s of [r4, r5, r6]) { await adopt(s, c1, 30); await adopt(s, c2, 31); }
  const r7 = await mkSkill("deptpop-r7");
  await adopt(r7, c1, 40); await adopt(r7, c2, 41);

  // — Skills that must NOT appear —
  const single = await mkSkill("deptpop-single"); // one colleague — under the floor
  await adopt(single, c1, 1);
  const stale = await mkSkill("deptpop-stale"); // the second adoption is 91 days old
  await adopt(stale, c1, 2); await adopt(stale, c2, 91);
  const otherDept = await mkSkill("deptpop-otherdept"); // the second adopter is in "DeptPop Eng Ops"
  await adopt(otherDept, c1, 3); await adopt(otherDept, ops, 3);
  const notCounted = await mkSkill("deptpop-notcounted"); // inactive, erased and opted-out colleagues
  for (const u of [c1, inactive, erased, hidden]) await adopt(notCounted, u, 3);
  const mine = await mkSkill("deptpop-mine"); // the viewer adopted it
  for (const u of [viewer, c1, c2, c3]) await adopt(mine, u, 3);
  const restricted = await mkSkill("deptpop-restricted", { nsId: otherNs, visibility: "namespace" });
  await adopt(restricted, c1, 1); await adopt(restricted, c2, 1);
  const archived = await mkSkill("deptpop-archived", { status: "archived" });
  await adopt(archived, c1, 1); await adopt(archived, c2, 1);
  const deprecated = await mkSkill("deptpop-deprecated", { deprecated: true });
  await adopt(deprecated, c1, 1); await adopt(deprecated, c2, 1);
  const unpublished = await mkSkill("deptpop-unpublished", { installable: false });
  await adopt(unpublished, c1, 1); await adopt(unpublished, c2, 1);
  const system = await mkSkill("deptpop-system"); // one colleague + a system installation clone
  await adopt(system, c1, 1);
  await q(`select record_git_access($1, null, true, true)`, [system]);

  const member = (userId: string | null): EffectiveAccess & { userId: string | null } =>
    ({ isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]), userId });
  const slugs = (r: Awaited<ReturnType<typeof departmentPopular>>) => r.skills.map((s) => s.skillSlug);

  try {
    await setDepartmentPopularEnabled(true, admin);
    resetDepartmentPopularCache();

    // — The row: order, tie-breaks, cap, counts, label —
    const res = await departmentPopular(member(viewer), now);
    assert.equal(res.department, "DeptPop Eng");
    assert.equal(res.windowDays, 90);
    assert.deepEqual(slugs(res), ["deptpop-r1", "deptpop-r2", "deptpop-r3", "deptpop-r4", "deptpop-r5", "deptpop-r6"],
      "colleagues desc → latest adoption desc → install count desc → title; capped at 6 (R7 dropped)");
    assert.deepEqual(res.skills.map((s) => s.colleagues), [4, 3, 3, 2, 2, 2]);
    const r1Card = res.skills[0]!;
    assert.equal(r1Card.namespaceSlug, "deptpop-ns", "a full catalog card");
    assert.equal(typeof r1Card.installCount, "number");
    for (const absent of ["deptpop-r7", "deptpop-single", "deptpop-stale", "deptpop-otherdept", "deptpop-notcounted", "deptpop-mine",
      "deptpop-restricted", "deptpop-archived", "deptpop-deprecated", "deptpop-unpublished", "deptpop-system"]) {
      assert.ok(!slugs(res).includes(absent), `${absent} is not on the row`);
    }
    assert.ok(!/deptpop-c\d|deptpop-hidden/.test(JSON.stringify(res)), "no colleague is ever named");

    // — Matching: a viewer whose department differs only in case and spaces is in the same
    //   department and gets their own trimmed spelling in the heading. For them the first viewer is
    //   a colleague, so "mine" (4 adopters, latest 3 days ago) counts and leads; it was left out above
    //   only because that viewer adopted it —
    const res2 = await departmentPopular(member(viewer2), now);
    assert.equal(res2.department, "DEPTPOP eng");
    assert.deepEqual(slugs(res2), ["deptpop-mine", "deptpop-r1", "deptpop-r2", "deptpop-r3", "deptpop-r4", "deptpop-r5"]);
    assert.equal(res2.skills[0]!.colleagues, 4);

    // A different department ("DeptPop Eng Ops") has only one adopter of anything → nothing qualifies.
    const opsRes = await departmentPopular(member(ops), now);
    assert.equal(opsRes.department, "DeptPop Eng Ops");
    assert.deepEqual(opsRes.skills, []);

    // — No department / blank department / no user —
    assert.deepEqual(await departmentPopular(member(noDept), now), { department: null, windowDays: 90, skills: [] });
    assert.deepEqual(await departmentPopular(member(blankDept), now), { department: null, windowDays: 90, skills: [] });
    assert.deepEqual(await departmentPopular(member(null), now), { department: null, windowDays: 90, skills: [] });

    // — Visibility: a §42 grant to the viewer's namespace shows the restricted skill (step 2 is live) —
    await q(`insert into skill_namespace_grants (skill_id, namespace_id, granted_by) values ($1, $2, $3)`, [restricted, ns, admin]);
    const granted = await departmentPopular(member(viewer), now);
    const g = granted.skills.find((s) => s.skillSlug === "deptpop-restricted");
    assert.ok(g, "shared with the viewer's namespace ⇒ shown");
    assert.equal(g.colleagues, 2);
    assert.equal(g.sharedFrom, "deptpop-other", "the card carries the §42 shared marker");
    await q(`delete from skill_namespace_grants where skill_id = $1`, [restricted]);
    assert.ok(!slugs(await departmentPopular(member(viewer), now)).includes("deptpop-restricted"), "grant removed ⇒ hidden again");

    // — The cache: step 1 is reused for 10 minutes, step 2 is live —
    await adopt(single, c2, 0); // "single" now has 2 colleague adopters …
    assert.ok(!slugs(await departmentPopular(member(viewer), now)).includes("deptpop-single"), "… but the cached step 1 doesn't know yet");
    resetDepartmentPopularCache(); // the TTL elapsing
    const fresh = await departmentPopular(member(viewer), now);
    assert.equal(fresh.skills[0]?.skillSlug, "deptpop-r1");
    assert.ok(slugs(fresh).includes("deptpop-single"), "after the TTL a new adoption shows");
    await adopt(r1, viewer, 0); // the viewer adopts R1: dropped at once, no cache reset needed
    assert.ok(!slugs(await departmentPopular(member(viewer), now)).includes("deptpop-r1"), "the viewer's own adoption is live");

    // — The switch (audited); off ⇒ nothing, regardless of the cache —
    await setDepartmentPopularEnabled(false, admin);
    assert.deepEqual(await departmentPopular(member(viewer), now), { department: null, windowDays: 90, skills: [] });
    const audit = await q<{ after: { departmentPopularEnabled?: boolean } }>(
      `select after from audit_log where action = 'settings.updated' and target_id = 'department_popular_enabled'
        order by created_at desc limit 1`,
    );
    assert.equal(audit.rows[0]?.after.departmentPopularEnabled, false, "switching it off is audited");
    await setDepartmentPopularEnabled(true, admin);
    assert.ok((await departmentPopular(member(viewer), now)).skills.length > 0, "switching it back on shows the row again");
  } finally {
    await setDepartmentPopularEnabled(true, admin);
    resetDepartmentPopularCache();
    await q(`delete from skill_installs where skill_id in (select id from skills where namespace_id = any($1::uuid[]))`, [[ns, otherNs]]);
    await q(`delete from skill_namespace_grants where skill_id in (select id from skills where namespace_id = any($1::uuid[]))`, [[ns, otherNs]]);
  }
});
