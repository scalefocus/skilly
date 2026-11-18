// Relocate a moved skill's serving repo (SKILLY_SPEC.md §70.8). A move changes the skill's
// canonical address from <old-ns>/<slug> to <new-ns>/<slug>; the bare repo on disk still sits at
// the old address. Each sweep, for every alias:
//   • the old directory exists and the canonical one doesn't → rename it (atomic on one filesystem,
//     so every tag and `main` keep their commit SHAs and existing clones fetch cleanly);
//   • both exist and the canonical one is provisioned → remove the old directory (the canonical one
//     was synthesized by another path, e.g. the self-heal sweep).
// A directory that is a LIVE skill's canonical address is never touched: an alias never shares an
// address with a live skill (migration 0112 triggers), and the query re-checks it anyway.
// Until a relocation runs, the git server serves the skill from whichever address is provisioned.
import type { Pool } from "pg";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoPath, repoProvisioned } from "./repoStore.js";
import { listTags } from "./synth.js";

export interface AliasRepoRow {
  /** The alias (old) address. */
  alias_ns_slug: string;
  alias_slug: string;
  /** The skill's canonical address. */
  ns_slug: string;
  skill_slug: string;
}

/** The aliases whose old directory may still need relocating — never one at a live skill's address. */
export async function loadAliasRepoRows(pool: Pick<Pool, "query">): Promise<AliasRepoRow[]> {
  const { rows } = await pool.query<AliasRepoRow>(
    `select an.slug as alias_ns_slug, a.slug as alias_slug, n.slug as ns_slug, s.slug as skill_slug
       from skill_path_aliases a
       join namespaces an on an.id = a.namespace_id
       join skills s on s.id = a.skill_id
       join namespaces n on n.id = s.namespace_id
      where not exists (select 1 from skills live where live.namespace_id = a.namespace_id and live.slug = a.slug)
      order by a.created_at asc`,
  );
  return rows;
}

async function exists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

export type RelocationOutcome = "renamed" | "removed" | "none";

/** Relocate one alias's directory (pure filesystem; the caller supplies the rows). */
export async function relocateOne(repoRoot: string, row: AliasRepoRow): Promise<RelocationOutcome> {
  let oldDir: string;
  let newDir: string;
  try {
    oldDir = repoPath(repoRoot, row.alias_ns_slug, row.alias_slug);
    newDir = repoPath(repoRoot, row.ns_slug, row.skill_slug);
  } catch {
    return "none"; // an unsafe slug never names a directory
  }
  if (oldDir === newDir || !(await exists(oldDir))) return "none";
  if (!(await exists(newDir))) {
    await mkdir(dirname(newDir), { recursive: true });
    await rename(oldDir, newDir);
    return "renamed";
  }
  // Both exist (a version was synthesized at the new address before the rename ran): keep the
  // canonical repo, and drop the old copy only once the canonical one carries every tag the old one
  // has — until the self-heal sweep fills the gap, the gateway keeps serving from the old copy.
  if (await repoProvisioned(repoRoot, row.ns_slug, row.skill_slug)) {
    const have = new Set(await listTags(newDir));
    const missing = (await listTags(oldDir)).some((t) => !have.has(t));
    if (missing) return "none";
    await rm(oldDir, { recursive: true, force: true });
    return "removed";
  }
  return "none";
}

/** The leader sweep entry point. Returns how many directories it renamed or removed. */
export async function relocateMovedRepos(pool: Pick<Pool, "query">, repoRoot: string): Promise<number> {
  let n = 0;
  for (const row of await loadAliasRepoRows(pool)) {
    try {
      const out = await relocateOne(repoRoot, row);
      if (out !== "none") {
        n++;
        console.log(JSON.stringify({
          level: "info",
          msg: out === "renamed" ? "relocated a moved skill's repo" : "removed a moved skill's stale repo",
          from: `${row.alias_ns_slug}/${row.alias_slug}`,
          to: `${row.ns_slug}/${row.skill_slug}`,
        }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: "error",
        msg: "relocate moved repo failed",
        from: `${row.alias_ns_slug}/${row.alias_slug}`,
        to: `${row.ns_slug}/${row.skill_slug}`,
        err: String(err),
      }));
    }
  }
  return n;
}

/** Test seam: the old and canonical directories for a row. */
export function relocationDirs(repoRoot: string, row: AliasRepoRow): { oldDir: string; newDir: string } {
  return { oldDir: join(repoRoot, row.alias_ns_slug, `${row.alias_slug}.git`), newDir: join(repoRoot, row.ns_slug, `${row.skill_slug}.git`) };
}
