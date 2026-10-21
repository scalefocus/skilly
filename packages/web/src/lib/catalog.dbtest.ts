// Live-DB integration test for archived-skill search scoping (SKILLY_SPEC.md §7, §19).
// Gated by SKILLY_DB_E2E=1. Verifies: archived skills are excluded by default; with
// includeArchived they surface ONLY for owners (platform admin / namespace admin / maintainer),
// never for a plain member — so the catalog "include archived" toggle can't leak.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { searchSkills, suggestSkills, skillDetailCore, listVersions, latestStableSemver, latestVersionUsage } from "./catalog";
import { isWatching, watcherCount } from "./watch";
import { skillDiscussionCount } from "./messages";
import { listGrants, isExplicitMaintainer } from "./grants";
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

test("skillDetailCore: matches the per-call helpers it replaces on the skill page", { skip: !enabled }, async () => {
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const nsId = async (slug: string) =>
    (await q<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`, [slug],
    )).rows[0]!.id;
  const userId = async (oid: string) =>
    (await q<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1, $1 || '@org', $1)
       on conflict (entra_object_id) do update set email = excluded.email returning id`, [oid],
    )).rows[0]!.id;
  const skillId = async (ns: string, slug: string, visibility: "org" | "namespace") =>
    (await q<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'claude', 'hosted', $3, 'active')
       on conflict (namespace_id, slug) do update set visibility = excluded.visibility returning id`, [ns, slug, visibility],
    )).rows[0]!.id;

  const owner = await nsId("sdc-owner");
  const granteeA = await nsId("sdc-grantee-a");
  const granteeB = await nsId("sdc-grantee-b");
  const viewer = await userId("sdc-viewer");
  const other = await userId("sdc-other");
  // Versions are immutable, so a re-run starts from fresh skills: drop the fixture's skills (their
  // versions, watches, maintainers and grants cascade) under the purge GUC, plus their discussions.
  const wipe = async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local skilly.allow_version_delete = 'on'");
      await c.query(
        `delete from conversations where subject_type = 'skill'
            and subject_id in (select id from skills where namespace_id = $1 and slug like 'sdc-%')`, [owner],
      );
      await c.query(`delete from skills where namespace_id = $1 and slug like 'sdc-%'`, [owner]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  };
  await wipe();
  const restricted = await skillId(owner, "sdc-restricted", "namespace");
  const orgSkill = await skillId(owner, "sdc-org", "org");
  try {
    // Versions: two stable actives (1.2.0 is latest, with usage), a newer beta, a yanked 2.0.0.
    await q(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, usage_examples, what_changed, created_at)
       values ($1, '1.0.0', false, 'active', 'k/sdc/1.0.0', 'h', 'old usage', null, now() - interval '4 days'),
              ($1, '1.2.0', false, 'active', 'k/sdc/1.2.0', 'h', 'current usage', 'fixes', now() - interval '3 days'),
              ($1, '2.0.0', false, 'yanked', 'k/sdc/2.0.0', 'h', 'yanked usage', null, now() - interval '2 days'),
              ($1, '2.1.0-beta.1', true, 'active', 'k/sdc/2.1.0-beta.1', 'h', 'beta usage', null, now() - interval '1 day')`,
      [restricted],
    );
    await q(`insert into skill_watches (user_id, skill_id) values ($1, $3), ($2, $3)`, [viewer, other, restricted]);
    await q(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [restricted, viewer]);
    // Inserted B before A so the display-name ordering is actually exercised.
    await q(`insert into skill_namespace_grants (skill_id, namespace_id, granted_by) values ($1, $2, $4), ($1, $3, null)`, [restricted, granteeB, granteeA, other]);
    const conv = (await q<{ id: string }>(`insert into conversations (subject_type, subject_id) values ('skill', $1) returning id`, [restricted])).rows[0]!.id;
    await q(
      `insert into messages (conversation_id, author_id, body, removed_at) values ($1, $2, 'one', null), ($1, $3, 'two', null), ($1, $2, 'gone', now())`,
      [conv, viewer, other],
    );

    const old = async (id: string, user: string | null, includeGrants: boolean) => ({
      versions: await listVersions(id),
      latest: await latestStableSemver(id),
      usageExamples: await latestVersionUsage(id),
      watching: user ? await isWatching(user, id) : false,
      watchers: await watcherCount(id),
      discussionCount: await skillDiscussionCount(id),
      grants: includeGrants ? await listGrants(id) : [],
      explicitMaintainer: await isExplicitMaintainer(id, user),
    });

    const seen = await skillDetailCore(restricted, viewer, true);
    assert.deepEqual(seen, await old(restricted, viewer, true));
    // Spot-check the fixture really exercises every field.
    assert.equal(seen.latest, "1.2.0");
    assert.equal(seen.usageExamples, "current usage");
    assert.deepEqual(seen.versions.map((v) => v.semver), ["2.1.0-beta.1", "2.0.0", "1.2.0", "1.0.0"]);
    assert.equal(seen.watchers, 2);
    assert.equal(seen.watching, true);
    assert.equal(seen.discussionCount, 2, "removed messages don't count");
    assert.deepEqual(seen.grants.map((g) => g.slug), ["sdc-grantee-a", "sdc-grantee-b"]);
    assert.equal(seen.explicitMaintainer, true);

    // Another signed-in viewer, an anonymous one, grants skipped, and an empty org skill.
    assert.deepEqual(await skillDetailCore(restricted, other, true), await old(restricted, other, true));
    assert.deepEqual(await skillDetailCore(restricted, null, true), await old(restricted, null, true));
    assert.deepEqual(await skillDetailCore(restricted, viewer, false), await old(restricted, viewer, false));
    const empty = await skillDetailCore(orgSkill, viewer, false);
    assert.deepEqual(empty, await old(orgSkill, viewer, false));
    assert.deepEqual(empty, { versions: [], latest: null, usageExamples: null, watching: false, watchers: 0, discussionCount: 0, grants: [], explicitMaintainer: false });
  } finally {
    await wipe();
  }
});
