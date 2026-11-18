// The disk purge after a namespace delete (SKILLY_SPEC.md §72.4). Bare repos live at
// `<repo-root>/<ns>/<slug>.git`, keyed by slug, and synthesis reuses an existing directory with the
// tags it holds — so a deleted namespace's directories must be gone before its slug can name a new
// namespace, or a same-slug skill there would serve the deleted skill's old tags to a new audience.
//
// The web app queues one `repo_disk_purges` row per deleted namespace (and refuses the slug while it
// exists). Each leader publish sweep, for every queued row:
//   1. relocates each moved-out skill whose repo still sits at the old address (the §70.8 rename),
//   2. removes `<repo-root>/<ns>/` recursively,
//   3. removes the namespace's marketplace repo (the marketplace sweep can't: the row is gone),
//   4. deletes the queue row.
// Every step is idempotent; a failure is logged and the row retried at the next sweep. Until then the
// directories are unreachable — the git gateway resolves every request from the database.
import type { Pool } from "pg";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { relocateOne } from "./relocate.js";
import { removeMarketplaceRepo } from "./marketplace.js";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface PurgeRow {
  id: string;
  namespace_slug: string;
  relocations: { slug: string; skillId: string }[];
}

/** The deleted namespace's directory under the repo root; throws on anything but a plain slug. */
export function namespaceRepoDir(repoRoot: string, namespaceSlug: string): string {
  if (!SLUG.test(namespaceSlug)) throw new Error("invalid namespace slug");
  const root = resolve(repoRoot);
  const dir = resolve(join(root, namespaceSlug));
  if (dir === root || !dir.startsWith(root)) throw new Error("path traversal blocked");
  return dir;
}

export async function loadPurgeRows(pool: Pick<Pool, "query">): Promise<PurgeRow[]> {
  const { rows } = await pool.query<{ id: string; namespace_slug: string; relocations: unknown }>(
    `select id, namespace_slug, relocations from repo_disk_purges order by created_at asc`,
  );
  return rows.map((r) => ({
    id: r.id,
    namespace_slug: r.namespace_slug,
    relocations: Array.isArray(r.relocations)
      ? r.relocations.filter((x): x is { slug: string; skillId: string } => !!x && typeof x.slug === "string" && typeof x.skillId === "string")
      : [],
  }));
}

/** Purge one queued namespace. Throws on a filesystem failure (the row stays queued). */
export async function purgeOne(pool: Pick<Pool, "query">, repoRoot: string, row: PurgeRow): Promise<{ relocated: number }> {
  const dir = namespaceRepoDir(repoRoot, row.namespace_slug);
  let relocated = 0;
  for (const r of row.relocations) {
    // The skill's canonical address now. A skill permanently deleted since has none — skip it.
    const { rows } = await pool.query<{ ns_slug: string; skill_slug: string }>(
      `select n.slug as ns_slug, s.slug as skill_slug from skills s join namespaces n on n.id = s.namespace_id where s.id = $1`,
      [r.skillId],
    );
    const canon = rows[0];
    if (!canon || canon.ns_slug === row.namespace_slug) continue;
    const out = await relocateOne(repoRoot, { alias_ns_slug: row.namespace_slug, alias_slug: r.slug, ns_slug: canon.ns_slug, skill_slug: canon.skill_slug });
    if (out === "renamed") relocated++;
  }
  // Anything still here is unreachable: archived skills purged with the namespace, or an old copy the
  // canonical repo doesn't carry every tag of yet — the self-heal sweep re-synthesizes those tags.
  await rm(dir, { recursive: true, force: true });
  await removeMarketplaceRepo(repoRoot, { kind: "namespace", namespaceSlug: row.namespace_slug });
  await pool.query(`delete from repo_disk_purges where id = $1`, [row.id]);
  return { relocated };
}

/** The leader-sweep entry point: purge every queued namespace. Returns how many were purged. */
export async function purgeDeletedNamespaces(pool: Pick<Pool, "query">, repoRoot: string): Promise<number> {
  let n = 0;
  for (const row of await loadPurgeRows(pool)) {
    try {
      const { relocated } = await purgeOne(pool, repoRoot, row);
      n++;
      console.log(JSON.stringify({ level: "info", msg: "purged a deleted namespace's repos", namespace: row.namespace_slug, relocated }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "namespace disk purge failed", namespace: row.namespace_slug, err: String(err) }));
    }
  }
  return n;
}
