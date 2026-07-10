// Live-DB integration test for archived-skill search scoping (SKILLY_SPEC.md §7, §19).
// Gated by SKILLY_DB_E2E=1. Verifies: archived skills are excluded by default; with
// includeArchived they surface ONLY for owners (platform admin / namespace admin / maintainer),
// never for a plain member — so the catalog "include archived" toggle can't leak.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { searchSkills, suggestSkills } from "./catalog";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

// Two tests now share this pool — close it once, after both have run, not per-test.
after(async () => {
  if (enabled) await pool.end();
});

test("catalog: archived skills are owner-scoped under includeArchived", { skip: !enabled }, async () => {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('arch-ns','Arch NS', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const maint = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('arch-maint','am@org','AM')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const memberUser = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('arch-member','mem@org','MEM')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;

    const mk = async (slug: string, status: "active" | "archived") => {
      const id = (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
         values ($1,$2,$2,'d','claude','hosted','org',$3)
         on conflict (namespace_id, slug) do update set status = excluded.status returning id`,
        [ns, slug, status],
      )).rows[0]!.id;
      return id;
    };
    const activeSkill = await mk("arch-active", "active");
    const archivedSkill = await mk("arch-archived", "archived");
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [archivedSkill, maint]);

    const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
    const nsAdmin: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) };
    const member: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

    const has = (rows: { skillSlug: string }[], slug: string) => rows.some((r) => r.skillSlug === slug);

    // Default (active only): archived never appears; active does.
    const defPlat = await searchSkills(platform, { limit: 200 });
    assert.ok(!has(defPlat, "arch-archived"), "default hides archived (platform)");
    assert.ok(has(defPlat, "arch-active"), "default shows active (platform)");
    assert.ok(!has(await searchSkills(member, { limit: 200 }), "arch-archived"), "default hides archived (member)");

    // archivedOnly: shows ONLY archived, owner-scoped. Active is excluded; non-owners see none.
    assert.ok(has(await searchSkills(platform, { archivedOnly: true, ownerUserId: null, limit: 200 }), "arch-archived"), "platform admin sees archived");
    assert.ok(!has(await searchSkills(platform, { archivedOnly: true, ownerUserId: null, limit: 200 }), "arch-active"), "archivedOnly excludes active (platform)");
    assert.ok(has(await searchSkills(nsAdmin, { archivedOnly: true, ownerUserId: null, limit: 200 }), "arch-archived"), "ns admin sees archived");
    assert.ok(has(await searchSkills(member, { archivedOnly: true, ownerUserId: maint, limit: 200 }), "arch-archived"), "maintainer sees their archived skill");
    assert.ok(!has(await searchSkills(member, { archivedOnly: true, ownerUserId: memberUser, limit: 200 }), "arch-archived"), "non-owner member sees nothing");

    // archived rows carry status='archived'.
    const padmin = await searchSkills(platform, { archivedOnly: true, ownerUserId: null, limit: 200 });
    assert.equal(padmin.find((r) => r.skillSlug === "arch-archived")?.status, "archived");

    // cleanup
    await pool.query(`delete from skill_maintainers where skill_id = any($1::uuid[])`, [[activeSkill, archivedSkill]]);
    await pool.query(`delete from skills where id = any($1::uuid[])`, [[activeSkill, archivedSkill]]);
});

test("suggestSkills: orgOnly excludes namespace-restricted skills even for a member with access", { skip: !enabled }, async () => {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('sugg-ns','Sugg NS', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const orgSkill = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1,'sugg-org-skill','Sugg Org Skill','d','claude','hosted','org','active')
       on conflict (namespace_id, slug) do update set visibility = 'org', status = 'active' returning id`, [ns],
    )).rows[0]!.id;
    const restrictedSkill = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1,'sugg-restricted-skill','Sugg Restricted Skill','d','claude','hosted','namespace','active')
       on conflict (namespace_id, slug) do update set visibility = 'namespace', status = 'active' returning id`, [ns],
    )).rows[0]!.id;

    // A member WITH namespace access would normally see the restricted skill in a plain search —
    // orgOnly must exclude it regardless (§26: the fulfilment link must be openable by everyone).
    const member: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) };
    const orgOnlyResults = await suggestSkills(member, "sugg", 10, { orgOnly: true });
    const slugs = orgOnlyResults.map((r) => r.skillSlug);
    assert.ok(slugs.includes("sugg-org-skill"), "org-visible skill is included");
    assert.ok(!slugs.includes("sugg-restricted-skill"), "namespace-restricted skill is excluded under orgOnly");

    // Without orgOnly, the same member's normal namespace access surfaces the restricted skill.
    const normalResults = await suggestSkills(member, "sugg", 10);
    assert.ok(normalResults.map((r) => r.skillSlug).includes("sugg-restricted-skill"), "normal search still shows it via namespace access");

    await pool.query(`delete from skills where id = any($1::uuid[])`, [[orgSkill, restrictedSkill]]);
});
