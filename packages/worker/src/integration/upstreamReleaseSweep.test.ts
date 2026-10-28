// Live-DB integration test for the upstream-release sweep (SKILLY_SPEC.md §63.3, §63.5, §63.13).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL. The upstream is
// stubbed: no network is touched.
//
// Validates: a semver-tag baseline with a newer release that changed the folder gets a row and one
// notification per effective maintainer (minus the opt-out), and a second pass is silent and reuses
// the folder check; a higher release notifies again naming only the highest; an unchanged folder, a
// branch pin and a deprecated skill send nothing; an open covering proposal sets notified_ref
// without notifying; a skills-hub baseline alerts with no folder fetch; one listing per origin per
// pass; a failed listing records last_error; a skip covers its release; the switch off skips the pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDigest, type BundleEntry, type RemoteRefCommitsResult } from "@skilly/shared";
import { sweepUpstreamReleases, type UpstreamDeps } from "../upstreamReleases.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

const ORIGIN = "https://git.example.test/acme/skills.git";
const BROKEN = "https://git.example.test/acme/broken.git";
const HUB = "https://skills-hub.ai/api/v1/skills/usr-hub";
const sha = (c: string) => c.repeat(40).slice(0, 40);
const files = (body: string): BundleEntry[] => [{ path: "SKILL.md", bytes: Buffer.from(body) }];
const CHANGED = files("---\nname: usr-pdf\ndescription: d\n---\n# new\n");

test("upstream release sweep: detect, notify once per release, folder check, cover, skip, kill switch", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const setSetting = (key: string, value: unknown) =>
    q(
      `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );

  const ns = await one(
    `insert into namespaces (slug, display_name, require_review) values ('usr-ns','Upstream Sweep NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  );
  const mkUser = (oid: string, on = true) =>
    one(
      `insert into users (entra_object_id, email, display_name, status, upstream_release_notifications) values ($1, $1 || '@org', $1, 'active', $2)
       on conflict (entra_object_id) do update set status = 'active', upstream_release_notifications = excluded.upstream_release_notifications returning id`,
      [oid, on],
    );
  const maint = await mkUser("usr-maint");
  const optOut = await mkUser("usr-optout", false);
  const nsAdmin = await mkUser("usr-nsadmin");
  const everyone = [maint, optOut, nsAdmin];
  const grp = await one(
    `insert into groups (entra_object_id, display_name) values ('usr-admin-grp','Upstream Sweep Admins')
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
  );
  await q(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [grp, ns]);
  await q(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grp, nsAdmin]);

  // A pointer skill with one stable version pinned to `ref` (versions are immutable, so the fixtures
  // are idempotent upserts that never change a pinned field).
  const mkSkill = async (slug: string, origin: string, ref: string, subdir: string | null, contentSha: string, deprecated = false) => {
    const id = await one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1,$2,$2,'d','claude','pointer','org','active')
       on conflict (namespace_id, slug) do update set status = 'active', deprecated_at = null returning id`,
      [ns, slug],
    );
    if (deprecated) await q(`update skills set deprecated_at = now() where id = $1`, [id]);
    await q(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published,
                                   external_origin_url, external_ref, external_subdir, content_sha256)
       values ($1,'1.0.0',false,'active',$3,'h',$2,true,$4,$5,$6,$7)
       on conflict (skill_id, semver) do update set status = 'active'`,
      [id, maint, `pointers/usr/${id}`, origin, ref, subdir, contentSha],
    );
    return id;
  };
  const pdf = await mkSkill("usr-pdf", ORIGIN, "v1.2.0", "pdf", "base-digest");
  const docx = await mkSkill("usr-docx", ORIGIN, "v1.2.0", "docx", contentDigest(CHANGED)); // same files upstream ⇒ unchanged
  const covered = await mkSkill("usr-covered", ORIGIN, "v1.2.0", "covered", "base-digest");
  const branch = await mkSkill("usr-branch", ORIGIN, "main", "branch", "base-digest");
  const deprecated = await mkSkill("usr-deprecated", ORIGIN, "v1.2.0", "dep", "base-digest", true);
  const hub = await mkSkill("usr-hub", HUB, "1.0.0", null, "base-digest");
  const broken = await mkSkill("usr-broken", BROKEN, "v1.0.0", null, "base-digest");
  const skills = [pdf, docx, covered, branch, deprecated, hub, broken];
  await q(`insert into skill_maintainers (skill_id, user_id) values ($1,$2),($1,$3) on conflict do nothing`, [pdf, maint, optOut]);

  // An open new-version proposal for usr-covered pinning v1.3.0 (§63.5 covering proposal).
  const proposal = await one(
    `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by)
     values ($1,$2,'1.1.0','proposed',$3) returning id`,
    [ns, covered, maint],
  );
  await q(
    `insert into proposal_revisions (proposal_id, revision_no, payload, author) values ($1, 1, $2::jsonb, $3)`,
    [proposal, JSON.stringify({ pointer: { url: "git@git.example.test:acme/skills.git", ref: "v1.3.0", subdir: "covered" } }), maint],
  );

  // The stubbed upstream.
  let tags = new Map([["v1.2.0", sha("a")], ["v1.3.0", sha("b")], ["v2.0.0-rc.1", sha("c")], ["release-x", sha("d")]]);
  const calls = { git: 0, registry: 0, fetch: 0 };
  const deps: UpstreamDeps = {
    listGit: async (url): Promise<RemoteRefCommitsResult> => {
      calls.git++;
      if (url === BROKEN) return { ok: false, error: "couldn’t read this repository’s refs" };
      return { ok: true, heads: new Map([["main", sha("e")]]), tags };
    },
    listRegistry: async () => {
      calls.registry++;
      return { ok: true, branches: [], tags: ["1.0.0", "1.1.0", "2.0.0-beta"], latest: "1.1.0" };
    },
    fetchFiles: async () => {
      calls.fetch++;
      return { files: CHANGED };
    },
  };
  const run = () => sweepUpstreamReleases(pool, deps, { minAgeSeconds: 0, skillIds: skills });
  const rowOf = async (skillId: string) =>
    (await q<{
      pin_kind: string; release_ref: string | null; release_bump: string | null; files_changed: boolean | null;
      notified_ref: string | null; last_error: string | null; detected_at: Date | null;
    }>(`select pin_kind, release_ref, release_bump, files_changed, notified_ref, last_error, detected_at from skill_upstream_releases where skill_id = $1`, [skillId])).rows[0] ?? null;
  const notes = async (userId: string) =>
    (await q<{ payload: Record<string, unknown> }>(
      `select payload from notifications where type = 'skill.upstream_release' and user_id = $1 order by created_at`, [userId],
    )).rows.map((r) => r.payload);

  const clean = async () => {
    await q(`delete from skill_upstream_releases where skill_id = any($1::uuid[])`, [skills]);
    await q(`delete from notifications where type = 'skill.upstream_release' and user_id = any($1::uuid[])`, [everyone]);
  };
  await clean();
  await q(`delete from platform_settings where key = 'upstream_releases_enabled'`);
  try {
    const first = await run();
    assert.equal(first.skipped, false);
    assert.equal(first.checked, 6, "the deprecated skill is not eligible");
    assert.equal(calls.git, 2, "one listing per origin per pass");
    assert.equal(calls.registry, 1);

    const pdfRow = await rowOf(pdf);
    assert.equal(pdfRow?.pin_kind, "semver_tag");
    assert.equal(pdfRow?.release_ref, "v1.3.0", "the prerelease and the non-semver tag are ignored");
    assert.equal(pdfRow?.release_bump, "minor");
    assert.equal(pdfRow?.files_changed, true);
    assert.equal(pdfRow?.notified_ref, "v1.3.0");
    assert.ok(pdfRow?.detected_at);

    // usr-pdf: the explicit maintainer and the namespace admin; never the opt-out.
    const m1 = await notes(maint);
    assert.equal(m1.length, 1);
    assert.deepEqual(
      { ns: m1[0]!.namespaceSlug, slug: m1[0]!.skillSlug, cur: m1[0]!.currentRef, rel: m1[0]!.releaseRef, bump: m1[0]!.bump },
      { ns: "usr-ns", slug: "usr-pdf", cur: "v1.2.0", rel: "v1.3.0", bump: "minor" },
    );
    assert.equal((await notes(optOut)).length, 0, "upstream_release_notifications = false ⇒ no row");
    // The namespace admin maintains every skill in the namespace: usr-pdf and usr-hub alert.
    const adminNotes = await notes(nsAdmin);
    assert.deepEqual(adminNotes.map((p) => p.skillSlug).sort(), ["usr-hub", "usr-pdf"]);
    assert.equal(adminNotes.find((p) => p.skillSlug === "usr-hub")!.releaseRef, "1.1.0", "registry: the highest stable version");

    // usr-docx: the release left its folder unchanged.
    const docxRow = await rowOf(docx);
    assert.equal(docxRow?.files_changed, false);
    assert.equal(docxRow?.notified_ref, null);
    // usr-covered: an open proposal for v1.3.0 silences it for good.
    assert.equal((await rowOf(covered))?.notified_ref, "v1.3.0");
    // usr-branch: a branch has no releases.
    const branchRow = await rowOf(branch);
    assert.equal(branchRow?.pin_kind, "branch");
    assert.equal(branchRow?.release_ref, null);
    // usr-deprecated: never checked.
    assert.equal(await rowOf(deprecated), null);
    // usr-hub: registry — no folder fetch.
    assert.equal((await rowOf(hub))?.pin_kind, "registry");
    // usr-broken: the failure is recorded.
    assert.match((await rowOf(broken))?.last_error ?? "", /refs/);
    const fetchesAfterFirst = calls.fetch;
    assert.equal(fetchesAfterFirst, 3, "pdf, docx and covered each fetched their folder once");

    // Second pass, nothing changed upstream: silent, and the folder checks are reused.
    await run();
    assert.equal((await notes(maint)).length, 1);
    assert.equal((await notes(nsAdmin)).length, 2);
    assert.equal(calls.fetch, fetchesAfterFirst, "the folder check is cached per (release, commit, baseline)");

    // A higher release: notifies again, naming only the highest.
    tags = new Map([...tags, ["v1.4.0", sha("f")], ["v1.3.1", sha("g")]]);
    await run();
    const m2 = await notes(maint);
    assert.equal(m2.length, 2);
    assert.equal(m2[1]!.releaseRef, "v1.4.0");
    // usr-covered: v1.4.0 is above the open proposal's v1.3.0, so it alerts now.
    assert.equal((await rowOf(covered))?.notified_ref, "v1.4.0");
    assert.ok((await notes(nsAdmin)).some((p) => p.skillSlug === "usr-covered" && p.releaseRef === "v1.4.0"));

    // A skip covers its release: v1.5.0 skipped ⇒ no alert; v1.6.0 supersedes the skip.
    tags = new Map([...tags, ["v1.5.0", sha("h")]]);
    await q(`update skill_upstream_releases set skipped_ref = 'v1.5.0', skipped_by = $2, skipped_at = now() where skill_id = $1`, [pdf, maint]);
    await run();
    assert.equal((await notes(maint)).length, 2, "a skipped release is not notified");
    tags = new Map([...tags, ["v1.6.0", sha("i")]]);
    await run();
    const m3 = await notes(maint);
    assert.equal(m3.length, 3);
    assert.equal(m3[2]!.releaseRef, "v1.6.0");

    // Kill switch: the pass skips and touches nothing.
    await setSetting("upstream_releases_enabled", false);
    const off = await run();
    assert.equal(off.skipped, true);
  } finally {
    await q(`delete from platform_settings where key = 'upstream_releases_enabled'`);
    await q(`delete from proposal_revisions where proposal_id = $1`, [proposal]);
    await q(`delete from proposals where id = $1`, [proposal]);
    await clean();
    await pool.end();
  }
});
