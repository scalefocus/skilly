// Reviewer file-change view (SKILLY_SPEC.md §8): classify a new-version proposal's files against
// the target skill's LATEST STABLE active version (added / modified / removed / unchanged, by
// per-file content hash) and produce inline unified line diffs for text/Markdown files.
//
//  - Baseline (old side): the latest stable active version's stored artifact — extracted from the
//    object store (hosted AND pointer alike; a pointer's mirror is a skilly-stored tarball).
//  - Proposed (new side): a hosted/reuse bundle is in the object store; a FRESH pointer proposal
//    has nothing stored pre-accept, so its files are fetched ON DEMAND at review (pointerFetch).
//  - A new-skill proposal (or a pointer skill's first version) has no baseline → every file is
//    "added".
//
// The loaded entry pair is cached per (proposal, revision) so the summary call and each lazy
// per-file diff call don't re-extract / re-clone. Text detection + the object-store extractor are
// the SAME ones the bundle file browser uses (bundleBrowse.ts).
import { createHash } from "node:crypto";
import { pool } from "./db";
import { loadBundleEntries, isTextFile } from "./bundleBrowse";
import { fetchPointerReviewEntries } from "./pointerFetch";
import { createTtlCache } from "./ttlCache";
import { diffLines, resolveLatest, type BundleEntry, type LineDiff } from "@skilly/shared";
import type { RevisionPayload } from "./proposals";

export type FileStatus = "added" | "modified" | "removed" | "unchanged";

export interface FileChange {
  path: string;
  status: FileStatus;
  /** Text on the side that exists (proposed for add/modify/unchanged; baseline for removed). */
  isText: boolean;
  /** Size in bytes on the side that exists. */
  size: number;
}

export interface ChangeSummary {
  /** The version diffed against; null when there's no baseline (a skill's first version). */
  baselineSemver: string | null;
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  files: FileChange[];
  /** Set when the proposed files can't be sourced (e.g. a skills-hub fresh pointer, or a fetch
   *  error) — the UI then falls back to the plain browser / upstream link. */
  unavailable?: string;
}

export type FileDiffResult =
  | { status: FileStatus; isText: boolean; diff: LineDiff }
  | { status: FileStatus; isText: boolean; tooLarge: true }
  | { status: FileStatus; isText: false; binary: true };

/** Max bytes per side before a text file's inline diff is refused ("download to compare"). §8. */
const MAX_DIFF_BYTES = Number(process.env.REVIEW_DIFF_MAX_BYTES ?? 500 * 1024);
const PAIR_TTL_MS = Number(process.env.REVIEW_DIFF_CACHE_TTL_MS ?? 300_000);

interface EntryPair {
  baselineSemver: string | null;
  base: Map<string, BundleEntry>;
  proposed: Map<string, BundleEntry>;
  unavailable?: string;
}
const pairCache = createTtlCache<EntryPair>(PAIR_TTL_MS);

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const byPath = (entries: BundleEntry[]): Map<string, BundleEntry> => new Map(entries.map((e) => [e.path, e]));

/** The target skill's latest stable active version's stored files (the diff baseline), or null. */
async function loadBaseline(targetSkillId: string): Promise<{ semver: string; entries: BundleEntry[] } | null> {
  const { rows } = await pool.query<{ semver: string; artifact_object_key: string | null }>(
    `select semver, artifact_object_key from skill_versions where skill_id = $1 and status = 'active'`,
    [targetSkillId],
  );
  const latest = resolveLatest(rows.map((r) => r.semver));
  if (!latest) return null;
  const key = rows.find((r) => r.semver === latest)?.artifact_object_key;
  if (!key) return null; // a pointer whose mirror is still pending
  return { semver: latest, entries: await loadBundleEntries(key) };
}

/** The proposal's proposed files: object-store bundle (hosted / reuse) or an on-demand pointer
 *  checkout (fresh pointer). Returns an `unavailable` reason when the proposed side can't be read. */
async function loadProposed(payload: RevisionPayload): Promise<{ entries: BundleEntry[] } | { unavailable: string }> {
  if (payload.artifactObjectKey) return { entries: await loadBundleEntries(payload.artifactObjectKey) };
  if (payload.pointer) {
    const r = await fetchPointerReviewEntries(payload.pointer.url, payload.pointer.ref, payload.pointer.subdir);
    return r.ok ? { entries: r.entries } : { unavailable: r.error };
  }
  return { unavailable: "this proposal has no files to compare" };
}

/** Load + cache the baseline/proposed entry maps for a (proposal, revision). */
async function loadPair(cacheKey: string, targetSkillId: string | null, payload: RevisionPayload): Promise<EntryPair> {
  return pairCache.get(cacheKey, async () => {
    const [baseline, proposed] = await Promise.all([
      targetSkillId ? loadBaseline(targetSkillId) : Promise.resolve(null),
      loadProposed(payload),
    ]);
    if ("unavailable" in proposed) {
      return { baselineSemver: baseline?.semver ?? null, base: new Map(), proposed: new Map(), unavailable: proposed.unavailable };
    }
    return {
      baselineSemver: baseline?.semver ?? null,
      base: baseline ? byPath(baseline.entries) : new Map(),
      proposed: byPath(proposed.entries),
    };
  });
}

/** Full added/modified/removed/unchanged classification for the review page. */
export async function getChangeSummary(cacheKey: string, targetSkillId: string | null, payload: RevisionPayload): Promise<ChangeSummary> {
  const pair = await loadPair(cacheKey, targetSkillId, payload);
  if (pair.unavailable) {
    return { baselineSemver: pair.baselineSemver, added: 0, modified: 0, removed: 0, unchanged: 0, files: [], unavailable: pair.unavailable };
  }
  const paths = [...new Set([...pair.base.keys(), ...pair.proposed.keys()])].sort((a, b) => a.localeCompare(b));
  const files: FileChange[] = [];
  let added = 0, modified = 0, removed = 0, unchanged = 0;
  for (const path of paths) {
    const oldE = pair.base.get(path);
    const newE = pair.proposed.get(path);
    if (oldE && !newE) {
      files.push({ path, status: "removed", isText: isTextFile(oldE.bytes), size: oldE.bytes.length });
      removed++;
    } else if (!oldE && newE) {
      files.push({ path, status: "added", isText: isTextFile(newE.bytes), size: newE.bytes.length });
      added++;
    } else if (oldE && newE) {
      const same = sha(oldE.bytes) === sha(newE.bytes);
      files.push({ path, status: same ? "unchanged" : "modified", isText: isTextFile(newE.bytes), size: newE.bytes.length });
      same ? unchanged++ : modified++;
    }
  }
  return { baselineSemver: pair.baselineSemver, added, modified, removed, unchanged, files };
}

/** Lazy per-file diff: a unified line diff for a diffable text file, else a binary/too-large marker. */
export async function getFileDiff(cacheKey: string, targetSkillId: string | null, payload: RevisionPayload, path: string): Promise<FileDiffResult | null> {
  const pair = await loadPair(cacheKey, targetSkillId, payload);
  if (pair.unavailable) return null;
  const oldE = pair.base.get(path);
  const newE = pair.proposed.get(path);
  if (!oldE && !newE) return null;
  const status: FileStatus = oldE && newE ? (sha(oldE.bytes) === sha(newE.bytes) ? "unchanged" : "modified") : oldE ? "removed" : "added";

  const oldBin = oldE ? !isTextFile(oldE.bytes) : false;
  const newBin = newE ? !isTextFile(newE.bytes) : false;
  if (oldBin || newBin) return { status, isText: false, binary: true };

  if ((oldE && oldE.bytes.length > MAX_DIFF_BYTES) || (newE && newE.bytes.length > MAX_DIFF_BYTES)) {
    return { status, isText: true, tooLarge: true };
  }
  const dec = new TextDecoder("utf-8");
  const oldText = oldE ? dec.decode(oldE.bytes) : "";
  const newText = newE ? dec.decode(newE.bytes) : "";
  const d = diffLines(oldText, newText);
  if (!d.ok) return { status, isText: true, tooLarge: true };
  return { status, isText: true, diff: d.diff };
}
