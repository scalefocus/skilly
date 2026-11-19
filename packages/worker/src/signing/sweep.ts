// The signing backfill + re-sign sweep (SKILLY_SPEC.md §73.6, §73.9). Leader-only, batched.
//
// Covers every version that already left the publish sweep — `git_published`, or yanked /
// quarantined (they may still be installed) — that has no statement from a non-revoked key:
//   • never signed (published before signing existed)  → kind `backfill`;
//   • signed only by revoked keys                       → kind `resign`.
// Each one re-reads the artifact, runs the §49.12 hash check, rebuilds the served files exactly as
// synthesis does and, while the tag is live, compares the rebuilt tree with the tag's. A mismatch
// is never signed: it is recorded for a human (the §49.12 discipline). Variants are signed by the
// paths that serve them (ensureMain, the marketplace sync), not here.
import type { Pool } from "pg";
import { bundleContentCap, versionTag } from "@skilly/shared";
import { getMaxBundleBytes } from "../settings.js";
import type { ArtifactStore } from "../storage/objectStore.js";
import { repoPath } from "../git/repoStore.js";
import { readRefFs } from "../git/mainRef.js";
import { servedFilesFromArtifact } from "../git/servedFiles.js";
import { treeOf, writeTree } from "../git/synth.js";
import { verifyArtifactIntegrity } from "../git/integrity.js";
import { insertAttestation, loadVersionIdentity } from "./attest.js";
import type { Signer } from "./key.js";
import { access } from "node:fs/promises";

export interface SigningSweepDeps {
  store: ArtifactStore;
  repoRoot: string;
  signer: Signer;
}

interface Candidate {
  id: string;
  skill_id: string;
  semver: string;
  artifact_object_key: string;
  artifact_sha256: string | null;
  ns_slug: string;
  skill_slug: string;
  namespace_id: string;
  revoked_only: boolean;
}

/** Versions given up on this run (integrity or tree mismatch, unreadable artifact) — logged once. */
const skipped = new Set<string>();
/** Counts since the sweep last ran out of work, for the completion audit rows. */
const progress = { backfill: 0, resign: 0, skipped: 0 };

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface SigningSweepResult {
  backfilled: number;
  resigned: number;
  skipped: number;
}

export async function sweepSigning(pool: Pool, deps: SigningSweepDeps, batch = 50, scope: { skillIds?: string[] } = {}): Promise<SigningSweepResult> {
  const result: SigningSweepResult = { backfilled: 0, resigned: 0, skipped: 0 };
  if (!(await deps.signer.usable())) return result;
  const { rows } = await pool.query<Candidate>(
    `select sv.id, sv.skill_id, sv.semver, sv.artifact_object_key, sv.artifact_sha256,
            n.slug as ns_slug, s.slug as skill_slug, s.namespace_id,
            exists (select 1 from skill_version_attestations a where a.skill_version_id = sv.id and a.variant_key = '') as revoked_only
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where sv.artifact_object_key is not null
        and (sv.git_published or sv.status in ('yanked', 'quarantined'))
        and not exists (
          select 1 from skill_version_attestations a join signing_keys k on k.key_id = a.key_id
           where a.skill_version_id = sv.id and a.variant_key = '' and k.revoked_at is null)
        and not (sv.id = any($1::uuid[]))
        and ($2::uuid[] is null or sv.skill_id = any($2::uuid[]))
      order by sv.created_at asc
      limit ${Math.max(1, Math.floor(batch))}`,
    [[...skipped], scope.skillIds ?? null],
  );

  if (rows.length === 0) {
    if (!scope.skillIds) await auditCompletion(pool);
    return result;
  }

  const cap = bundleContentCap(await getMaxBundleBytes(pool));
  for (const v of rows) {
    try {
      const bytes = await deps.store.get(v.artifact_object_key);
      if (!(await verifyArtifactIntegrity(pool, { versionId: v.id, skillId: v.skill_id, semver: v.semver, artifactKey: v.artifact_object_key, expectedSha256: v.artifact_sha256, namespaceId: v.namespace_id, nsSlug: v.ns_slug, skillSlug: v.skill_slug }, bytes, "worker:signing"))) {
        skip(v.id, result);
        continue;
      }
      const files = await servedFilesFromArtifact(bytes, v.skill_slug, cap);
      const bare = repoPath(deps.repoRoot, v.ns_slug, v.skill_slug);
      const tag = versionTag(v.semver);
      const tagCommit = (await exists(bare)) ? await readRefFs(bare, `refs/tags/${tag}`) : null;
      if (tagCommit) {
        const expected = await treeOf(bare, tagCommit);
        const rebuilt = await writeTree(bare, files);
        if (expected !== rebuilt) {
          await recordTreeMismatch(pool, v, expected, rebuilt);
          skip(v.id, result);
          continue;
        }
      }
      const identity = await loadVersionIdentity(pool, v.id);
      if (!identity) continue;
      const kind = v.revoked_only ? "resign" : "backfill";
      await insertAttestation(pool, deps.signer, { identity, files, variant: null, kind, tagCommit });
      if (kind === "resign") {
        result.resigned++;
        progress.resign++;
      } else {
        result.backfilled++;
        progress.backfill++;
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "signing sweep: could not sign version", versionId: v.id, err: String(err) }));
      const permanent = err instanceof Error && /NoSuchKey|NoSuchBucket|does not exist|not found|unsafe path/i.test(err.message);
      if (permanent) skip(v.id, result);
    }
  }
  return result;
}

function skip(id: string, result: SigningSweepResult): void {
  skipped.add(id);
  result.skipped++;
  progress.skipped++;
}

/** §73.12: once the sweep runs out of work, one audit row per kind of work it did. */
async function auditCompletion(pool: Pool): Promise<void> {
  const rows: [string, Record<string, number>][] = [];
  if (progress.backfill > 0) rows.push(["signing.backfill_completed", { signed: progress.backfill, skipped: progress.skipped }]);
  if (progress.resign > 0) rows.push(["signing.resign_completed", { signed: progress.resign, skipped: progress.skipped }]);
  if (rows.length === 0) return;
  for (const [action, after] of rows) {
    await pool.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, after, source) values (null, $1, 'signing', 'sweep', $2::jsonb, 'worker')`,
      [action, JSON.stringify(after)],
    );
  }
  console.log(JSON.stringify({ level: "info", msg: "signing sweep finished", ...progress }));
  progress.backfill = 0;
  progress.resign = 0;
  progress.skipped = 0;
}

/** §73.6: the served tag no longer matches its artifact — never signed, a human decides. */
async function recordTreeMismatch(pool: Pool, v: Candidate, expected: string | null, actual: string): Promise<void> {
  console.error(JSON.stringify({ level: "error", msg: "served tree differs from the artifact; not signed", versionId: v.id, expected, actual }));
  try {
    await pool.query(
      `insert into system_event (status, method, route, path, user_id, error_code, message, source)
       values (500, 'JOB', 'worker:signing', $1, null, 'attestation_tree_mismatch', $2, 'worker')`,
      [`/${v.ns_slug}/${v.skill_slug}`.slice(0, 500), `the served tag of @${v.ns_slug}/${v.skill_slug} v${v.semver} does not match its artifact — not signed`.slice(0, 300)],
    );
    await pool.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, after, source)
       values (null, 'skill.attestation_tree_mismatch', 'skill_version', $1, $2, $3::jsonb, 'worker')`,
      [`${v.skill_id}@${v.semver}`, v.namespace_id, JSON.stringify({ skill: v.skill_slug, semver: v.semver, expectedTree: expected, actualTree: actual })],
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "could not record tree mismatch", err: String(err) }));
  }
}
