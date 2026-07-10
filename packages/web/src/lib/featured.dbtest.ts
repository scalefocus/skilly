// Live-DB integration test for the "Featured skills" homepage spotlight (SKILLY_SPEC.md §7).
// Gated by SKILLY_DB_E2E=1. Verifies: platform-admin-only + installable/active gating, the
// max_featured_skills cap (409), the visibility-filtered feed (invariant #3 — a restricted
// Featured skill never surfaces to outsiders), installable-only rendering + most-recent-first
// ordering, and the auto-clear of the flag on archive and on all-versions-yanked.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { findSkill, listFeaturedSkills } from "./catalog";
import { setSkillFeatured, setSkillArchived, setVersionYanked } from "./manage";
import { setMaxFeaturedSkills } from "./settings";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("featured skills: gating, cap, visibility feed, and auto-clear", { skip: !enabled }, async () => {
  try {
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('feat-ns','Feat NS', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const admin = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('feat-admin','fadmin@org','FAdmin')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;

    const mkSkill = async (slug: string, visibility: "org" | "namespace", status: "active" | "archived") =>
      (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
         values ($1,$2,$2,'d','claude','hosted',$3,$4)
         on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = excluded.status,
           featured_at = null, featured_by = null returning id`,
        [ns, slug, visibility, status],
      )).rows[0]!.id;
    const mkVersion = async (skillId: string, semver: string, gitPublished: boolean) =>
      pool.query(
        `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
         values ($1,$2,false,'active','k/'||$2,'h',$3,$4)
         on conflict (skill_id, semver) do update set status = 'active', git_published = excluded.git_published`,
        [skillId, semver, admin, gitPublished],
      );

    const org1 = await mkSkill("feat-org1", "org", "active");
    await mkVersion(org1, "1.0.0", true); // installable
    const restricted = await mkSkill("feat-restricted", "namespace", "active");
    await mkVersion(restricted, "1.0.0", true); // installable
    const noVersion = await mkSkill("feat-noversion", "org", "active");
    await mkVersion(noVersion, "1.0.0", false); // active but NOT git-published → not installable
    const archived = await mkSkill("feat-archived", "org", "archived");

    const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
    const member: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) };
    const outsider: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

    const feature = (a: EffectiveAccess, slug: string, featured: boolean) =>
      setSkillFeatured(pool, { access: a, actorUserId: admin, namespaceSlug: "feat-ns", skillSlug: slug, featured });
    const isFeatured = async (slug: string) => (await findSkill("feat-ns", slug))!.featured;
    const has = (rows: { skillSlug: string }[], slug: string) => rows.some((r) => r.skillSlug === slug);

    // Reset the cap to its default for a clean run (a prior run may have changed it).
    await setMaxFeaturedSkills(10, admin);

    // — Gating —
    const denied = await feature(member, "feat-org1", true);
    assert.equal(denied.ok, false, "non-platform-admin cannot feature");
    if (!denied.ok) assert.equal(denied.status, 403);
    const archRej = await feature(platform, "feat-archived", true);
    assert.equal(archRej.ok, false, "archived skill rejected");
    if (!archRej.ok) assert.equal(archRej.status, 409);
    const noVerRej = await feature(platform, "feat-noversion", true);
    assert.equal(noVerRej.ok, false, "non-installable rejected");
    if (!noVerRej.ok) assert.equal(noVerRej.status, 409);
    assert.equal(await isFeatured("feat-org1"), false, "rejected attempts changed nothing");

    // — Cap (§7): full cap blocks a new spotlight; lowering never evicts —
    await setMaxFeaturedSkills(1, admin);
    assert.equal((await feature(platform, "feat-org1", true)).ok, true, "first feature under cap 1 succeeds");
    const capped = await feature(platform, "feat-restricted", true);
    assert.equal(capped.ok, false, "second feature at cap 1 is blocked");
    if (!capped.ok) assert.match(capped.error, /already featured/, "cap error is the human banner");
    await setMaxFeaturedSkills(10, admin);
    assert.equal((await feature(platform, "feat-restricted", true)).ok, true, "raising the cap unblocks");

    // — Feed visibility (invariant #3) —
    assert.ok(has(await listFeaturedSkills(platform), "feat-restricted"), "platform admin sees restricted featured");
    assert.ok(has(await listFeaturedSkills(member), "feat-restricted"), "ns member sees restricted featured");
    assert.ok(has(await listFeaturedSkills(outsider), "feat-org1"), "outsider sees org featured");
    assert.ok(!has(await listFeaturedSkills(outsider), "feat-restricted"), "outsider NEVER sees restricted featured");

    // — Ordering: most-recently-featured first (set explicit stamps to make it deterministic) —
    await pool.query(`update skills set featured_at = now() - interval '2 hours' where id = $1`, [org1]);
    await pool.query(`update skills set featured_at = now() where id = $1`, [restricted]);
    const ordered = (await listFeaturedSkills(platform)).map((s) => s.skillSlug);
    assert.ok(ordered.indexOf("feat-restricted") < ordered.indexOf("feat-org1"), "newer-featured sorts first");

    // — Installable-only rendering: a Featured-but-not-installable skill is hidden yet stays flagged —
    await pool.query(`update skill_versions set git_published = false where skill_id = $1`, [org1]);
    assert.ok(!has(await listFeaturedSkills(platform), "feat-org1"), "non-installable featured skill is hidden from the feed");
    assert.equal(await isFeatured("feat-org1"), true, "…but its featured flag persists");
    await pool.query(`update skill_versions set git_published = true where skill_id = $1`, [org1]);

    // — Auto-clear on archive —
    assert.equal((await setSkillArchived(pool, { access: platform, actorUserId: admin, namespaceSlug: "feat-ns", skillSlug: "feat-restricted", archived: true })).ok, true);
    assert.equal(await isFeatured("feat-restricted"), false, "archiving clears the featured flag");

    // — Auto-clear when all versions are yanked —
    assert.equal(await isFeatured("feat-org1"), true, "org1 still featured before yank");
    assert.equal((await setVersionYanked(pool, { access: platform, actorUserId: admin, namespaceSlug: "feat-ns", skillSlug: "feat-org1", semver: "1.0.0", yanked: true })).ok, true);
    assert.equal(await isFeatured("feat-org1"), false, "yanking the last version clears the featured flag");

    // cleanup: drop the test skills (cascades to versions — open the immutability guard) + reset the cap.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local skilly.allow_version_delete = 'on'");
      await client.query(`delete from skills where id = any($1::uuid[])`, [[org1, restricted, noVersion, archived]]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    await pool.query(`delete from platform_settings where key = 'max_featured_skills'`);
  } finally {
    await pool.end();
  }
});
