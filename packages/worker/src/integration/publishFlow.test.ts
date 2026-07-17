// Live-DB integration test for the publish chain (HOSTED + POINTER). Gated behind
// SKILLY_DB_E2E=1. Requires a migrated Postgres at DATABASE_URL.
//
//   1) start pg + apply db/migrations (0001 + 0003 + 0004)
//   2) SKILLY_DB_E2E=1 DATABASE_URL=postgres://... node --test dist/integration/publishFlow.test.js
//
// Validates: materialize-shaped hosted version + a mirrored pointer version both flow
// through validate -> scan -> synthesize -> git clone, and git_published flips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { create } from "tar";
import AdmZip from "adm-zip";
import { publishPendingVersions } from "../git/publish.js";
import { withdrawYankedVersions } from "../git/withdraw.js";
import { refreshPointerVersions } from "../git/pointerRefresh.js";
import { repoPath } from "../git/repoStore.js";
import { synthesizeVersion } from "../git/synth.js";
import { mirrorPointerVersion } from "../git/mirror.js";
import { mirrorPendingVersions } from "../git/mirrorPending.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const exec = promisify(execFile);
const enc = (s: string) => new TextEncoder().encode(s);
const enabled = process.env.SKILLY_DB_E2E === "1";
// The "external" upstream is a local bare repo, so allow the worker's file:// clone here.
// In production this flag is unset and only https:// pointers are accepted (SSRF guard, §6).
process.env.SKILLY_MIRROR_ALLOW_INSECURE = "1";
const cloneEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
const clone = (repo: string, dest: string) => exec("git", ["clone", "-c", "credential.helper=", repo, dest], { env: cloneEnv });

test("publish chain (hosted + pointer): seed -> sweep -> clone", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const work = await mkdtemp(join(tmpdir(), "skilly-e2e-"));
  try {
    // In-memory object store (put + get).
    const mem = new Map<string, Buffer>();
    const store: ArtifactStore = {
      async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
      async put(k, b) { mem.set(k, b); },
    };

    // Hosted bundle: build a tar.gz (name must match slug 'pdf') and stash under 'k-e2e'.
    const hsrc = join(work, "hsrc");
    await mkdir(hsrc, { recursive: true });
    await writeFile(join(hsrc, "SKILL.md"), "---\nname: pdf\ndescription: e2e\n---\n# PDF e2e\n");
    const htgz = join(work, "h.tgz");
    await create({ gzip: true, file: htgz, cwd: hsrc }, ["."]);
    mem.set("k-e2e", await (await import("node:fs/promises")).readFile(htgz));

    // "External" repo for the pointer skill (stand-in for an upstream git host).
    const externalRepo = join(work, "external.git");
    await synthesizeVersion({
      bareRepoPath: externalRepo,
      semver: "1.0.0",
      isLatestStable: true,
      files: [{ path: "SKILL.md", bytes: enc("---\nname: ptr\ndescription: mirrored\n---\n# mirrored\n") }],
    });

    // Seed namespace + user.
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('team-a','Team A', false)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const user = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('e2e-oid','e2e@org','E2E')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;

    // Hosted skill + version (materialize-shaped row).
    const hosted = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,'pdf','PDF','pdf tools','claude-code','hosted','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns],
    )).rows[0]!.id;
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,'1.0.0',false,'active','k-e2e','deadbeef',$2,false)
       on conflict (skill_id, semver) do nothing`,
      [hosted, user],
    );

    // Pointer skill + mirrored version.
    const pointer = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,'ptr','Ptr','mirrored skill','claude-code','pointer','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns],
    )).rows[0]!.id;
    const mirrored = await mirrorPointerVersion(pool, store, {
      skillId: pointer, skillSlug: "ptr", semver: "1.0.0",
      externalUrl: externalRepo, ref: "v1.0.0", createdBy: user, isPrerelease: false,
    });

    // Pointer via the PENDING-MIRROR path (what proposal-accept / direct-publish enqueues).
    const externalRepo2 = join(work, "external2.git");
    await synthesizeVersion({
      bareRepoPath: externalRepo2,
      semver: "1.0.0",
      isLatestStable: true,
      files: [{ path: "SKILL.md", bytes: enc("---\nname: ptr-pending\ndescription: via pending\n---\n# via pending\n") }],
    });
    const pending = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,'ptr-pending','Ptr Pending','via pending','claude-code','pointer','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns],
    )).rows[0]!.id;
    await pool.query(
      `insert into pending_mirrors (skill_id, semver, external_url, external_ref, is_prerelease, created_by)
       values ($1,'1.0.0',$2,'v1.0.0',false,$3) on conflict (skill_id, semver) do nothing`,
      [pending, externalRepo2, user],
    );
    const drained = await mirrorPendingVersions(pool, { store });
    assert.ok(drained >= 1, "drained the pending mirror");
    assert.equal((await pool.query(`select 1 from pending_mirrors where skill_id = $1`, [pending])).rowCount, 0, "pending_mirrors cleared");
    assert.ok((await pool.query(`select 1 from skill_versions where skill_id = $1 and semver = '1.0.0'`, [pending])).rowCount, "pending mirror created the version");

    // HOSTED skill delivered as a .zip bundle (exercises the zip extraction path end-to-end).
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("---\nname: zipped\ndescription: zip e2e\n---\n# Zipped skill\n"));
    mem.set("k-zip", zip.toBuffer());
    const zipped = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,'zipped','Zipped','zip bundle','claude-code','hosted','org')
       on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
      [ns],
    )).rows[0]!.id;
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,'1.0.0',false,'active','k-zip','feedface',$2,false)
       on conflict (skill_id, semver) do nothing`,
      [zipped, user],
    );

    // A watcher follows the hosted skill — publishing should notify them (watch/follow, §12).
    await pool.query(`insert into skill_watches (user_id, skill_id) values ($1,$2) on conflict do nothing`, [user, hosted]);

    // Maintainers are implicit watchers too (§19): an explicit maintainer + the namespace's
    // admin (via a role_mapping group) should both receive skill.new_version.
    const maintainer = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('e2e-maint','m@org','M')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [hosted, maintainer]);
    const nsAdmin = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('e2e-nsadmin','a@org','A')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const adminGroup = (await pool.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ('e2e-admin-grp','E2E Admins')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [adminGroup, ns]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [adminGroup, nsAdmin]);

    // §12 maintainer notification prefs: an opted-out maintainer gets NO row at all
    // (row-level), while an explicit watch outranks the new-version opt-out (watch wins).
    const nvOff = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, new_version_notifications) values ('e2e-nvoff','nv@org','NVOff',false)
       on conflict (entra_object_id) do update set new_version_notifications = false returning id`,
    )).rows[0]!.id;
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [hosted, nvOff]);
    // The watcher seeded above is ALSO made an opted-out maintainer — their watch must still notify.
    await pool.query(`update users set new_version_notifications = false where id = $1`, [user]);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [hosted, user]);

    // Publish sweep handles hosted (tar.gz + zip) + both pointers.
    const repoRoot = join(work, "repos");
    const n = await publishPendingVersions(pool, { store, repoRoot });
    assert.ok(n >= 4, `published >= 4 versions (got ${n})`);

    // The zip-delivered skill is cloneable with the right content.
    const zClone = join(work, "cz");
    await clone(repoPath(repoRoot, "team-a", "zipped"), zClone);
    assert.match((await exec("git", ["-C", zClone, "show", "v1.0.0:SKILL.md"])).stdout, /Zipped skill/);

    // Clone hosted + pointer; verify content.
    const hClone = join(work, "ch");
    await clone(repoPath(repoRoot, "team-a", "pdf"), hClone);
    assert.match((await exec("git", ["-C", hClone, "show", "v1.0.0:SKILL.md"])).stdout, /PDF e2e/);

    const pClone = join(work, "cp");
    await clone(repoPath(repoRoot, "team-a", "ptr"), pClone);
    assert.match((await exec("git", ["-C", pClone, "show", "v1.0.0:SKILL.md"])).stdout, /mirrored/);

    // The pending-mirror pointer is cloneable too (full enqueue → mirror → publish path).
    const ppClone = join(work, "cpp");
    await clone(repoPath(repoRoot, "team-a", "ptr-pending"), ppClone);
    assert.match((await exec("git", ["-C", ppClone, "show", "v1.0.0:SKILL.md"])).stdout, /via pending/);

    // The watcher received a new-version notification for the hosted skill — even though
    // they're also a maintainer who opted out: the explicit watch wins (§12).
    const watchNotif = await pool.query(
      `select 1 from notifications where user_id = $1 and type = 'skill.new_version' and payload->>'skillSlug' = 'pdf'`,
      [user],
    );
    assert.ok(watchNotif.rowCount! >= 1, "watcher notified of the new version (watch outranks the opt-out)");

    // The opted-out (non-watching) maintainer got nothing — the pref is row-level (§12).
    assert.equal(
      (await pool.query(`select 1 from notifications where user_id = $1 and type = 'skill.new_version'`, [nvOff])).rowCount,
      0,
      "opted-out maintainer receives no new-version notification row",
    );

    // The explicit maintainer AND the namespace admin were notified too (§19 fan-out union).
    for (const [who, uid] of [["maintainer", maintainer], ["namespace admin", nsAdmin]] as const) {
      const r = await pool.query(
        `select 1 from notifications where user_id = $1 and type = 'skill.new_version' and payload->>'skillSlug' = 'pdf'`,
        [uid],
      );
      assert.ok(r.rowCount! >= 1, `${who} notified of the new version`);
    }

    // git_published flipped for the hosted version.
    const ver = (await pool.query<{ git_published: boolean }>(
      `select git_published from skill_versions where skill_id = $1 and semver = '1.0.0'`,
      [hosted],
    )).rows[0]!;
    assert.equal(ver.git_published, true);

    // Scan happens at INGEST: the pointer mirror wrote an artifact-keyed scan report.
    const reports = (await pool.query<{ status: string }>(
      `select status from scan_reports where subject_type = 'artifact' and subject_id = $1`,
      [mirrored.artifactKey],
    )).rows;
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.status, "scanned");

    // Pointer refresh re-verifies the mirrored refs: re-clone + re-scan, no drift (same
    // upstream content), and a fresh pointer_ref scan report per pointer version.
    const refreshed = await refreshPointerVersions(pool, store, { minAgeSeconds: 0, limit: 50 });
    assert.ok(refreshed.checked >= 2, `re-checked the pointer versions (got ${refreshed.checked})`);
    assert.equal(refreshed.drift, 0, "freshly-mirrored pointers have not drifted");
    assert.ok(
      (await pool.query(`select 1 from scan_reports where subject_type = 'pointer_ref' and status = 'scanned'`)).rowCount! >= 2,
      "pointer_ref scan reports written",
    );

    // ── Upstream drift: onset-only notifications + per-user opt-out (§12) ──
    // Maintainers of the pointer skill: an explicit maintainer who opted out of drift
    // alerts, plus the namespace admin (implicit via the role mapping, default on).
    const driftOff = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, drift_notifications) values ('e2e-driftoff','d@org','DOff',false)
       on conflict (entra_object_id) do update set drift_notifications = false returning id`,
    )).rows[0]!.id;
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [pointer, driftOff]);
    const driftCount = async (uid: string) =>
      (await pool.query<{ n: number }>(
        `select count(*)::int as n from notifications where user_id = $1 and type = 'skill.drift' and payload->>'skillSlug' = 'ptr'`,
        [uid],
      )).rows[0]!.n;

    // Simulate upstream tampering: make the stored mirror artifact diverge from the clone.
    const origArtifact = mem.get(mirrored.artifactKey)!;
    const dsrc = join(work, "dsrc");
    await mkdir(dsrc, { recursive: true });
    await writeFile(join(dsrc, "SKILL.md"), "---\nname: ptr\ndescription: mirrored\n---\n# tampered\n");
    const dtgz = join(work, "d.tgz");
    await create({ gzip: true, file: dtgz, cwd: dsrc }, ["."]);
    const tampered = await readFile(dtgz);
    mem.set(mirrored.artifactKey, tampered);

    const drift1 = await refreshPointerVersions(pool, store, { minAgeSeconds: 0, limit: 50 });
    assert.ok(drift1.drift >= 1, "drift detected once stored artifact and upstream diverge");
    assert.equal(await driftCount(nsAdmin), 1, "namespace admin (implicit maintainer) alerted at drift onset");
    assert.equal(await driftCount(driftOff), 0, "opted-out maintainer gets no drift row (row-level, §12)");

    // Persistent drift stays silent (onset dedup): the next pass re-detects but never re-pings.
    const drift2 = await refreshPointerVersions(pool, store, { minAgeSeconds: 0, limit: 50 });
    assert.ok(drift2.drift >= 1, "drift still detected on the following pass");
    assert.equal(await driftCount(nsAdmin), 1, "no re-notification while the same drift persists");

    // Recovery re-arms: a clean pass, then a fresh divergence is a NEW onset and pings again.
    mem.set(mirrored.artifactKey, origArtifact);
    const cleanPass = await refreshPointerVersions(pool, store, { minAgeSeconds: 0, limit: 50 });
    assert.equal(cleanPass.drift, 0, "restored artifact matches upstream again");
    mem.set(mirrored.artifactKey, tampered);
    await refreshPointerVersions(pool, store, { minAgeSeconds: 0, limit: 50 });
    assert.equal(await driftCount(nsAdmin), 2, "a new drift onset after recovery pings again");
    mem.set(mirrored.artifactKey, origArtifact);

    // Yank withdrawal (§7): yanking a version drops its tag so it stops cloning.
    await pool.query(`update skill_versions set status = 'yanked' where skill_id = $1 and semver = '1.0.0'`, [zipped]);
    const withdrawn = await withdrawYankedVersions(pool, repoRoot);
    assert.ok(withdrawn >= 1, "withdrew the yanked version");
    const zippedRepo = repoPath(repoRoot, "team-a", "zipped");
    const tagsAfter = (await exec("git", ["--git-dir", zippedRepo, "tag"])).stdout;
    assert.ok(!/v1\.0\.0/.test(tagsAfter), "yanked version tag removed from the repo");
    const flag = (await pool.query<{ git_published: boolean }>(
      `select git_published from skill_versions where skill_id = $1 and semver = '1.0.0'`, [zipped],
    )).rows[0]!;
    assert.equal(flag.git_published, false, "git_published cleared on withdrawal");
    await assert.rejects(
      exec("git", ["clone", "--branch", "v1.0.0", zippedRepo, join(work, "cz-yanked")], { env: cloneEnv }),
      "cloning a yanked version fails",
    );
  } finally {
    await pool.end();
    await rm(work, { recursive: true, force: true });
  }
});
