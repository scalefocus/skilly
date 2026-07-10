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
