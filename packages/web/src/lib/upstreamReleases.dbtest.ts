// Live-DB integration test for the web side of upstream release alerts (SKILLY_SPEC.md §63.7, §63.8,
// §63.13). Gated by SKILLY_DB_E2E=1. The worker's sweep is simulated by writing the
// `skill_upstream_releases` row it would write.
//
// Verifies: the `upstream` block is null for a viewer who doesn't own the skill and carries the
// pending release, the bump and the pre-filled link for an owner; a covering open proposal turns it
// into "View the proposal"; skip refuses a stale ref (409 not_pending), hides the release behind the
// skipped line and is audited; un-skip restores it, is audited, and refuses when nothing is skipped
// (409 not_skipped); a higher release supersedes the skip; the switch off and a deprecated skill hide
// it; publishing a version that pins the release clears it at once; branch drift on the baseline shows
// the drift notice; only maintainers and admins may skip (canManageMaintainers).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { skipUpstreamRelease, unskipUpstreamRelease, upstreamDetail } from "./upstreamReleases";
import { setUpstreamReleasesEnabled } from "./settings";
import { canManageMaintainers } from "./maintainers";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("upstream releases: detail gating, covered, skip / un-skip, switch, deprecation, publish, branch drift", { skip: !enabled }, async () => {
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

  const ns = await one(
    `insert into namespaces (slug, display_name, require_review) values ('upr-ns','Upstream NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  );
  // Fixed actors (audit_log FK — never deleted).
  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
       on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
      [oid],
    );
  const maint = await mkUser("upr-maint");
  const viewer = await mkUser("upr-viewer");
  const admin = await mkUser("upr-platform-admin");

  const ORIGIN = "https://git.example.test/acme/skills.git";
  const skill = await one(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,'upr-pdf','upr-pdf','d','claude','pointer','org','active')
     on conflict (namespace_id, slug) do update set status = 'active', deprecated_at = null, deprecated_by = null,
       successor_skill_id = null, deprecation_note = null returning id`,
    [ns],
  );
  const version = async (semver: string, ref: string) =>
    one(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published,
                                   external_origin_url, external_ref, external_subdir, content_sha256)
       values ($1,$2,false,'active',$3,'h',$4,true,$5,$6,'pdf','digest')
       on conflict (skill_id, semver) do update set status = 'active' returning id`,
      [skill, semver, `pointers/upr/${skill}/${semver}`, maint, ORIGIN, ref],
    );
  // Versions are immutable and never deleted: a re-run first yanks what a previous run published.
  await q(`update skill_versions set status = 'yanked' where skill_id = $1 and semver = '1.1.0'`, [skill]);
  const baseline = await version("1.0.0", "v1.2.0");
  await q(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [skill, maint]);

  const facts = { id: skill, status: "active", deprecatedAt: null, namespaceSlug: "upr-ns", slug: "upr-pdf" };
  const writeRow = (release: string | null, semver: string | null) =>
    q(
      `insert into skill_upstream_releases (skill_id, baseline_version_id, origin_url, subdir, pin_kind, release_ref, release_semver,
                                            release_commit, release_bump, files_changed, detected_at, checked_at, notified_ref)
       values ($1,$2,$3,'pdf','semver_tag',$4,$5,'c','minor',true,now(),now(),$4)
       on conflict (skill_id) do update set baseline_version_id = excluded.baseline_version_id, pin_kind = excluded.pin_kind,
         release_ref = excluded.release_ref, release_semver = excluded.release_semver, files_changed = true`,
      [skill, baseline, "git@git.example.test:acme/skills.git", release, semver],
    );
  const proposals: string[] = [];
  const auditCount = async (action: string) =>
    (await q<{ n: number }>(`select count(*)::int as n from audit_log where action = $1 and target_id = $2`, [action, skill])).rows[0]!.n;

  await q(`delete from skill_upstream_releases where skill_id = $1`, [skill]);
  await setUpstreamReleasesEnabled(true, admin);
  try {
    // Never checked ⇒ nothing.
    assert.equal(await upstreamDetail(facts, true), null);

    await writeRow("v1.3.0", "1.3.0");
    assert.equal(await upstreamDetail(facts, false), null, "not an owner ⇒ no block");
    const d = await upstreamDetail(facts, true);
    assert.equal(d?.kind, "release");
    assert.equal(d?.currentRef, "v1.2.0");
    assert.deepEqual({ ref: d?.release?.ref, bump: d?.release?.bump }, { ref: "v1.3.0", bump: "minor" });
    assert.equal(d?.proposal, undefined);
    assert.equal(d?.proposePath, "/propose?newVersion=1&ns=upr-ns&slug=upr-pdf&upstreamRef=v1.3.0&upstreamKind=release&bump=minor");

    // An open proposal for v1.3.0 covers it.
    const p = await one(
      `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by) values ($1,$2,'1.1.0','under_review',$3) returning id`,
      [ns, skill, maint],
    );
    proposals.push(p);
    await q(`insert into proposal_revisions (proposal_id, revision_no, payload, author) values ($1,1,$2::jsonb,$3)`, [
      p, JSON.stringify({ pointer: { url: ORIGIN, ref: "v1.3.0", subdir: "pdf" } }), maint,
    ]);
    assert.deepEqual((await upstreamDetail(facts, true))?.proposal, { id: p });
    await q(`update proposals set state = 'rejected' where id = $1`, [p]);
    assert.equal((await upstreamDetail(facts, true))?.proposal, undefined, "a closed proposal no longer covers it");

    // Skip: a stale ref is refused; the pending one is skipped and audited.
    const skipFacts = { id: skill, namespaceId: ns, status: "active", deprecatedAt: null };
    assert.deepEqual(await skipUpstreamRelease(skipFacts, "v1.2.9", maint), { ok: false, status: 409, error: "not_pending" });
    const before = await auditCount("skill.upstream_release_skipped");
    assert.deepEqual(await skipUpstreamRelease(skipFacts, "v1.3.0", maint), { ok: true, ref: "v1.3.0" });
    assert.equal(await auditCount("skill.upstream_release_skipped"), before + 1);
    const skipped = await upstreamDetail(facts, true);
    assert.equal(skipped?.skipped?.ref, "v1.3.0");
    assert.equal(skipped?.skipped?.byName, "upr-maint");
    assert.deepEqual(await skipUpstreamRelease(skipFacts, "v1.3.0", maint), { ok: false, status: 409, error: "not_pending" }, "already skipped");

    // Un-skip restores it; a second un-skip has nothing to clear.
    const beforeUn = await auditCount("skill.upstream_release_unskipped");
    assert.deepEqual(await unskipUpstreamRelease(skipFacts, maint), { ok: true, ref: "v1.3.0" });
    assert.equal(await auditCount("skill.upstream_release_unskipped"), beforeUn + 1);
    assert.equal((await upstreamDetail(facts, true))?.skipped, undefined);
    assert.deepEqual(await unskipUpstreamRelease(skipFacts, maint), { ok: false, status: 409, error: "not_skipped" });

    // A higher release supersedes a skip.
    await skipUpstreamRelease(skipFacts, "v1.3.0", maint);
    await writeRow("v1.4.0", "1.4.0");
    const higher = await upstreamDetail(facts, true);
    assert.equal(higher?.release?.ref, "v1.4.0");
    assert.equal(higher?.skipped, undefined);

    // The switch off hides it; a deprecated skill has none.
    await setUpstreamReleasesEnabled(false, admin);
    assert.equal(await upstreamDetail(facts, true), null, "switch off");
    await setUpstreamReleasesEnabled(true, admin);
    assert.equal(await upstreamDetail({ ...facts, deprecatedAt: new Date().toISOString() }, true), null, "deprecated");

    // Publishing a version that pins the release clears it at once — no sweep needed.
    await version("1.1.0", "v1.4.0");
    assert.equal(await upstreamDetail(facts, true), null, "the new baseline pins v1.4.0");
    await q(`update skill_versions set status = 'yanked' where skill_id = $1 and semver = '1.1.0'`, [skill]);
    assert.equal((await upstreamDetail(facts, true))?.release?.ref, "v1.4.0", "back on the old baseline");

    // Branch drift on the baseline (classified by the refresh) shows the drift notice.
    await q(`update skill_upstream_releases set pin_kind = 'branch', release_ref = null, release_semver = null where skill_id = $1`, [skill]);
    assert.equal(await upstreamDetail(facts, true), null, "no drift report yet");
    await q(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref)
       values ('pointer_ref', $1, 'pointer-refresh', '[]'::jsonb, 'high', 'drift', 'v1.2.0')`,
      [baseline],
    );
    const drift = await upstreamDetail(facts, true);
    assert.equal(drift?.kind, "branch_drift");
    assert.equal(drift?.baselineSemver, "1.0.0");
    assert.equal(drift?.proposePath, "/propose?newVersion=1&ns=upr-ns&slug=upr-pdf&upstreamRef=v1.2.0&upstreamKind=branch");

    // Authority (the route's gate): a maintainer and a platform admin may skip, a plain viewer may not.
    const none: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
    const sk = { id: skill, namespaceId: ns, visibility: "org" as const };
    assert.equal(await canManageMaintainers(none, sk, maint), true);
    assert.equal(await canManageMaintainers(none, sk, viewer), false);
    assert.equal(await canManageMaintainers({ isPlatformAdmin: true, namespaceRoles: new Map() }, sk, admin), true);
  } finally {
    await q(`delete from scan_reports where subject_type = 'pointer_ref' and subject_id = $1`, [baseline]);
    await q(`delete from proposal_revisions where proposal_id = any($1::uuid[])`, [proposals]);
    await q(`delete from proposals where id = any($1::uuid[])`, [proposals]);
    await q(`delete from skill_upstream_releases where skill_id = $1`, [skill]);
    await q(`update skill_versions set status = 'yanked' where skill_id = $1 and semver = '1.1.0'`, [skill]);
    await q(`delete from platform_settings where key = 'upstream_releases_enabled'`);
  }
});
