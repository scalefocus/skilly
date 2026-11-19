// Live-DB integration test for signed skill versions in the worker (SKILLY_SPEC.md §73.15).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://... node --test dist/integration/signing.test.js
//
// Covers: the publish sweep signs before git_published (and a clone matches the statement); the
// backfill signs an already-served version as `backfill`; a served tag that no longer matches its
// artifact is never signed and is recorded; a revocation is re-signed as `resign` by a new key; a
// deprecated skill's `main` is signed as a `deprecation` variant before it is served, and a clone
// of `main` matches that variant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { create } from "tar";
import {
  describeLocalFiles,
  loadVersionStatements,
  resolveSigningRegistry,
  verifyFilesServerSide,
} from "@skilly/shared";
import { publishPendingVersions } from "../git/publish.js";
import { syncDeprecationMains } from "../git/mainRef.js";
import { synthesizeVersion } from "../git/synth.js";
import { repoPath } from "../git/repoStore.js";
import { deprecationHintSigner } from "../signing/attest.js";
import { testSigner } from "../signing/key.js";
import { sweepSigning } from "../signing/sweep.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const exec = promisify(execFile);
const enabled = process.env.SKILLY_DB_E2E === "1";
const cloneEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function walk(dir: string, root = dir): Promise<{ path: string; bytes: Uint8Array }[]> {
  const out: { path: string; bytes: Uint8Array }[] = [];
  for (const e of await readdir(dir)) {
    if (e === ".git") continue;
    const full = join(dir, e);
    if ((await stat(full)).isDirectory()) out.push(...(await walk(full, root)));
    else out.push({ path: relative(root, full).split("\\").join("/"), bytes: new Uint8Array(await readFile(full)) });
  }
  return out;
}

test("signing (§73): publish, backfill, tree mismatch, re-sign, deprecation variant", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const work = await mkdtemp(join(tmpdir(), "skilly-sign-"));
  try {
    const mem = new Map<string, Buffer>();
    const store: ArtifactStore = {
      async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
      async put(k, b) { mem.set(k, b); },
    };
    const repoRoot = join(work, "repos");
    const run = randomBytes(4).toString("hex");
    const T = `sig71-${run}`;
    const bundle = async (name: string, body: string, extra: Record<string, string> = {}) => {
      const src = join(work, `src-${name}`);
      await mkdir(join(src, "scripts"), { recursive: true });
      await writeFile(join(src, "SKILL.md"), `---\nname: ${T}\ndescription: signing test\n---\n${body}\n`);
      await writeFile(join(src, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
      for (const [p, c] of Object.entries(extra)) await writeFile(join(src, p), c);
      const tgz = join(work, `${name}.tgz`);
      await create({ gzip: true, file: tgz, cwd: src }, ["."]);
      return readFile(tgz);
    };

    const actor = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('sig71-actor','sig71@org','Sig71')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('sig71', 'sig71', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const skill = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'd', 'generic', 'hosted', 'org', 'active') returning id`,
      [ns, T],
    )).rows[0]!.id;
    const mkVersion = async (semver: string, bytes: Buffer, published: boolean) => {
      const key = `${T}/${semver}`;
      mem.set(key, bytes);
      return (await pool.query<{ id: string }>(
        `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
         values ($1, $2, false, 'active', $3, $4, $5, $6) returning id`,
        [skill, semver, key, sha256(bytes), actor, published],
      )).rows[0]!.id;
    };
    const statementsOf = async (versionId: string) =>
      (await pool.query<{ kind: string; key_id: string; variant_key: string; variant_rewrites: string[] }>(
        `select kind, key_id, variant_key, variant_rewrites from skill_version_attestations where skill_version_id = $1 order by created_at`,
        [versionId],
      )).rows;
    const bare = repoPath(repoRoot, "sig71", T);
    const registry = resolveSigningRegistry(process.env);

    // ── 1. Backfill: a version served before signing existed ────────────────────────────────
    const v0bytes = await bundle("v0", "# v0");
    const v0 = await mkVersion("0.9.0", v0bytes, true);
    const { extractBundle } = await import("../git/bundle.js");
    await synthesizeVersion({ bareRepoPath: bare, semver: "0.9.0", files: await extractBundle(v0bytes), isLatestStable: false });

    // ── 2. Tree mismatch: the served tag differs from the artifact ──────────────────────────
    const vxBytes = await bundle("vx", "# vx");
    const vx = await mkVersion("0.9.5", vxBytes, true);
    await synthesizeVersion({ bareRepoPath: bare, semver: "0.9.5", files: await extractBundle(await bundle("vx-other", "# NOT the artifact")), isLatestStable: false });

    const signer = await testSigner(pool);
    const swept = await sweepSigning(pool, { store, repoRoot, signer }, 50, { skillIds: [skill] });
    assert.equal(swept.backfilled, 1);
    assert.deepEqual((await statementsOf(v0)).map((r) => r.kind), ["backfill"]);
    assert.equal((await statementsOf(vx)).length, 0, "a served tree that doesn't match its artifact is never signed");
    const mismatch = await pool.query(`select 1 from audit_log where action = 'skill.attestation_tree_mismatch' and target_id = $1`, [`${skill}@0.9.5`]);
    assert.equal(mismatch.rowCount, 1);

    // ── 3. Publish: signed in the same step that sets git_published ────────────────────────
    const v1 = await mkVersion("1.0.0", await bundle("v1", `# v1 ${run}`), false);
    await publishPendingVersions(pool, { store, repoRoot, signer });
    assert.ok((await pool.query(`select 1 from skill_versions where id = $1 and git_published`, [v1])).rowCount);
    assert.deepEqual((await statementsOf(v1)).map((r) => r.kind), ["publish"]);

    // A clone of the tag matches the statement, checked the way REST/MCP check it.
    const dest = join(work, "clone-v1");
    await exec("git", ["clone", "--branch", "v1.0.0", bare, dest], { env: cloneEnv });
    const vs = (await loadVersionStatements(pool, skill, "1.0.0"))!;
    const verdict = await verifyFilesServerSide(pool, skill, vs, await describeLocalFiles(await walk(dest)), registry);
    assert.equal(verdict.overall, "match");
    assert.equal(verdict.signature, "valid");

    // ── 4. Deprecation: `main` is a signed variant before it is served ──────────────────────
    await pool.query(`update skills set deprecated_at = now(), deprecation_note = $2 where id = $1`, [skill, `note ${run}`]);
    await syncDeprecationMains(pool, repoRoot, undefined, (skillId, semver, bareRepoPath, state) =>
      deprecationHintSigner(pool, signer, { skillId, semver, bareRepoPath, state }));
    const v1rows = await statementsOf(v1);
    const variantRow = v1rows.find((r) => r.variant_key !== "");
    assert.ok(variantRow, "the deprecation commit is signed as a variant");
    assert.deepEqual(variantRow!.variant_rewrites, ["deprecation"]);
    assert.equal(variantRow!.kind, "publish", "a variant takes its version statement's kind");
    const mainDest = join(work, "clone-main");
    await exec("git", ["clone", bare, mainDest], { env: cloneEnv });
    const vsMain = (await loadVersionStatements(pool, skill, "1.0.0"))!;
    const mainVerdict = await verifyFilesServerSide(pool, skill, vsMain, await describeLocalFiles(await walk(mainDest)), registry);
    assert.equal(mainVerdict.overall, "match");
    assert.deepEqual(mainVerdict.variant?.rewrites, ["deprecation"]);
    await pool.query(`update skills set deprecated_at = null, deprecation_note = null where id = $1`, [skill]);

    // ── 5. Revocation: the re-sign sweep signs again with a new key, kind `resign` ──────────
    await pool.query(`update signing_keys set revoked_at = now(), revoked_reason = 'test' where key_id = $1`, [signer.keyId]);
    const signer2 = await testSigner(pool);
    const resigned = await sweepSigning(pool, { store, repoRoot, signer: signer2 }, 50, { skillIds: [skill] });
    assert.equal(resigned.resigned, 2, "v0.9.0 and v1.0.0 (the mismatched tag stays unsigned)");
    const v1after = (await loadVersionStatements(pool, skill, "1.0.0"))!;
    assert.equal(v1after.statements[0]!.keyId, signer2.keyId);
    assert.equal(v1after.statements[0]!.kind, "resign");
    // The old signer refuses to sign once revoked.
    assert.equal(await (await import("../signing/key.js")).signerFor(pool, signer.material).usable(), false);
  } finally {
    await pool.end();
    await rm(work, { recursive: true, force: true });
  }
});
