// Maps (namespace, skill) -> a bare git repo on disk under a repo root. The repo is the
// SERVING layer; the canonical immutable artifact lives in object storage. The root is
// threaded explicitly (not a module global) so callers/tests stay consistent.
// SKILLY_SPEC.md §6 ("serving architecture").
import { join, resolve } from "node:path";
import { access, readdir, readFile } from "node:fs/promises";

/** Default repo root from env (read lazily so tests can override). */
export function defaultRepoRoot(): string {
  return process.env.GIT_REPO_ROOT ?? "/data/git";
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Safe bare-repo path for a skill; rejects path traversal in slugs. */
export function repoPath(root: string, namespaceSlug: string, skillSlug: string): string {
  if (!SLUG.test(namespaceSlug) || !SLUG.test(skillSlug)) {
    throw new Error("invalid namespace or skill slug");
  }
  const p = resolve(join(root, namespaceSlug, `${skillSlug}.git`));
  if (!p.startsWith(resolve(root))) throw new Error("path traversal blocked");
  return p;
}

export async function repoExists(root: string, namespaceSlug: string, skillSlug: string): Promise<boolean> {
  try {
    await access(join(repoPath(root, namespaceSlug, skillSlug), "HEAD"));
    return true;
  } catch {
    return false;
  }
}

/** True iff the bare repo at `dir` carries at least one ref (loose under refs/, or in packed-refs).
 *  `git init --bare` writes HEAD + empty refs/{heads,tags} dirs BEFORE any ref exists, so a repo
 *  that was init'd but never had a tag/branch written (synthesis crashed mid-sweep) has HEAD but
 *  zero refs. Pure filesystem checks (no `git` spawn) so it's cheap on the git-server hot path. */
async function hasAnyRef(gitDir: string): Promise<boolean> {
  for (const sub of ["refs/heads", "refs/tags"]) {
    try {
      if ((await readdir(join(gitDir, sub))).length > 0) return true;
    } catch {
      // dir absent → no refs of this kind
    }
  }
  try {
    // A packed-refs line beginning with a 40-hex sha is a real ref (comments start with '#').
    if (/^[0-9a-f]{40}\s/m.test(await readFile(join(gitDir, "packed-refs"), "utf8"))) return true;
  } catch {
    // no packed-refs file
  }
  return false;
}

/**
 * "Provisioned" = the serving repo exists AND carries at least one ref. An empty repo (HEAD but
 * zero refs — `git init --bare` ran but synthesis failed before `update-ref`) is NOT provisioned:
 * serving it yields a misleading empty clone, and the self-heal sweep must re-synthesize it.
 * SKILLY_SPEC.md §6 ("serving architecture").
 */
export async function repoProvisioned(root: string, namespaceSlug: string, skillSlug: string): Promise<boolean> {
  const dir = repoPath(root, namespaceSlug, skillSlug);
  try {
    await access(join(dir, "HEAD"));
  } catch {
    return false;
  }
  return hasAnyRef(dir);
}

/** A skill repo's address on disk: `<root>/<namespaceSlug>/<skillSlug>.git`. */
export interface RepoAddress {
  namespaceSlug: string;
  skillSlug: string;
}

/**
 * §70.8: the repo directory to serve for a skill — the first PROVISIONED address in `candidates`
 * (the canonical address first, then the skill's old addresses, whose directory the relocation
 * sweep may not have renamed yet), or null when none is. Invalid slugs are skipped, never thrown.
 */
export async function pickServedRepo(root: string, candidates: readonly RepoAddress[]): Promise<RepoAddress | null> {
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.namespaceSlug}/${c.skillSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (await repoProvisioned(root, c.namespaceSlug, c.skillSlug)) return c;
    } catch {
      // an unsafe slug never names a directory to serve
    }
  }
  return null;
}

/**
 * §70.8: point git-http-backend at the directory actually served. `pathname` is the request's
 * `/<ns>/<slug>.git/<endpoint>`; its repo prefix is swapped for the served address's.
 */
export function rewriteRepoPathInfo(pathname: string, from: RepoAddress, to: RepoAddress): string {
  const prefix = `/${from.namespaceSlug}/${from.skillSlug}.git`;
  if (!pathname.startsWith(prefix)) return pathname;
  return `/${to.namespaceSlug}/${to.skillSlug}.git${pathname.slice(prefix.length)}`;
}
