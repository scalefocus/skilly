// Live-DB integration test for per-skill maintainers (SKILLY_SPEC.md §19). Gated by SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Validates: effective set = (live namespace admins ∪ explicit), the visibility eligibility
// gate (no restricted-skill leak), manage-permission (admin / maintainer), add/remove audit,
// candidate typeahead filtering, and ON DELETE CASCADE on deprovision.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { getEffectiveMaintainers, canManageMaintainers, addMaintainer, removeMaintainer, listCandidates } from "./maintainers";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("skill maintainers: effective set + eligibility + manage + cascade", { skip: !enabled }, async () => {
  try {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('maint-ns','Maint NS', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;

    // Admin group mapped to the namespace + member group; users wired via group_memberships.
    const adminGroup = (await pool.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ('maint-admin-grp','Maint Admins')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const memberGroup = (await pool.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ('maint-member-grp','Maint Members')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [adminGroup, ns]);
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_member') on conflict do nothing`, [memberGroup, ns]);

    const mkUser = async (oid: string, name: string) =>
      (await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
         on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
        [oid, `${oid}@org`, name],
      )).rows[0]!.id;
    const admin = await mkUser("maint-admin", "Ada Admin");
    const member = await mkUser("maint-member", "Mel Member");
    const outsider = await mkUser("maint-outsider", "Otto Outsider");
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [adminGroup, admin]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [memberGroup, member]);

    const mkSkill = async (slug: string, visibility: "org" | "namespace") =>
      (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
         values ($1,$2,$3,'d','claude','hosted',$4)
         on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
        [ns, slug, slug, visibility],
      )).rows[0]!.id;
    const restricted = await mkSkill("maint-restricted", "namespace");
    const org = await mkSkill("maint-org", "org");
    for (const s of [restricted, org]) await pool.query(`delete from skill_maintainers where skill_id = $1`, [s]);

    const rSkill = { id: restricted, namespaceId: ns, visibility: "namespace" as const };
    const oSkill = { id: org, namespaceId: ns, visibility: "org" as const };
    const adminAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) };
    const memberAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) };

    // Implicit: the namespace admin is a maintainer of every skill in the namespace.
    let eff = await getEffectiveMaintainers(rSkill);
    assert.deepEqual(eff.map((m) => m.userId), [admin], "admin is implicit maintainer");
    assert.equal(eff[0]!.source, "admin");

    // Eligibility gate: a member can be added to a restricted skill; an outsider cannot (#3).
    assert.equal(await addMaintainer(admin, rSkill, member), null, "member added");
    assert.ok((await addMaintainer(admin, rSkill, outsider)) !== null, "outsider rejected (can't see restricted skill)");

    eff = await getEffectiveMaintainers(rSkill);
    assert.deepEqual(new Set(eff.map((m) => m.userId)), new Set([admin, member]), "effective = admin ∪ explicit member");
    assert.equal(eff.find((m) => m.userId === member)!.source, "explicit");

    // Manage permission: admin yes; a plain member no — but once they're a maintainer, yes.
    assert.equal(await canManageMaintainers(adminAccess, rSkill, admin), true);
    assert.equal(await canManageMaintainers(memberAccess, oSkill, member), false, "member can't manage a skill they don't maintain");
    assert.equal(await canManageMaintainers(memberAccess, rSkill, member), true, "maintainer can manage co-maintainers");

    // Org skill: an outsider IS eligible (org-visible to all).
    assert.equal(await addMaintainer(admin, oSkill, outsider), null, "outsider added to org skill");
    assert.ok((await getEffectiveMaintainers(oSkill)).some((m) => m.userId === outsider));

    // Candidate typeahead: matches eligible users, excludes existing maintainers.
    const cands = await listCandidates(rSkill, "Otto");
    assert.equal(cands.length, 0, "outsider not a candidate for restricted skill (ineligible)");
    const memberCands = await listCandidates(oSkill, "Mel");
    assert.ok(memberCands.some((c) => c.userId === member), "eligible non-maintainer surfaces as candidate");

    // Remove + audit trail.
    await removeMaintainer(admin, rSkill, member);
    assert.ok(!(await getEffectiveMaintainers(rSkill)).some((m) => m.userId === member), "member removed");
    const actions = (await pool.query<{ action: string }>(`select distinct action from audit_log where target_id = $1`, [restricted])).rows.map((r) => r.action);
    assert.ok(actions.includes("skill.maintainer_added") && actions.includes("skill.maintainer_removed"), "maintainer mutations audited");

    // Cascade: deprovision the outsider → their org-skill maintainer row vanishes.
    await addMaintainer(admin, rSkill, member); // re-add for cascade check
    await pool.query(`delete from users where id = $1`, [outsider]);
    assert.ok(!(await getEffectiveMaintainers(oSkill)).some((m) => m.userId === outsider), "cascade removed deprovisioned maintainer");

    // cleanup
    for (const s of [restricted, org]) {
      await pool.query(`delete from skill_maintainers where skill_id = $1`, [s]);
      await pool.query(`delete from skills where id = $1`, [s]);
    }
    await pool.query(`delete from role_mappings where namespace_id = $1`, [ns]);
    await pool.query(`delete from group_memberships where group_id = any($1::uuid[])`, [[adminGroup, memberGroup]]);
    await pool.query(`delete from groups where entra_object_id like 'maint-%'`);
    // NB: the namespace and test users (maint-admin/member) are intentionally NOT deleted —
    // they're referenced by append-only audit_log (NO ACTION FKs, invariant #5), so they can't
    // be hard-deleted. Harmless (no roles after role_mappings are gone) and reused via upsert —
    // same pattern as admin.dbtest's 'team-z'.
  } finally {
    await pool.end();
  }
});
