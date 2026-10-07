// Withdraw yanked versions from the served git repos (SKILLY_SPEC.md §7). Yank flips the DB
// status to 'yanked'; this leader sweep reflects that at the git layer by deleting the version
// tag, so `git clone --branch v<semver>` (what `npx skills add` runs) fails with "remote
// branch not found". If the yanked version was the latest-stable (HEAD/main), main is repointed
// to the next latest-stable active version. We then clear git_published so that a RESTORE
// (status back to 'active') is re-synthesized by the publish sweep — synthesis is deterministic
// (fixed author/date), so the re-created tag points at the identical commit. No version row or
// artifact is mutated (invariant #2 — yank withdraws availability, it doesn't alter the version).
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { Pool } from "pg";
import { versionTag, resolveLatest } from "@skilly/shared";
import { sweepBatchSize } from "./publish.js";
import { repoPath } from "./repoStore.js";
import { ensureMain, loadDeprecationState } from "./mainRef.js";

function git(args: string[], gitDir: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { env: { ...process.env, GIT_DIR: gitDir, GIT_CONFIG_NOSYSTEM: "1" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({ code: 1, out: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end();
  });
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function withdrawYankedVersions(pool: Pool, repoRoot: string): Promise<number> {
  // Versions marked yanked whose tag is still live (git_published=true).
  const { rows } = await pool.query<{ id: string; semver: string; skill_id: string; ns_slug: string; skill_slug: string }>(
    `select sv.id, sv.semver, sv.skill_id, n.slug as ns_slug, s.slug as skill_slug
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where sv.status = 'yanked' and sv.git_published = true
      order by sv.created_at asc
      limit ${sweepBatchSize()}`,
  );

  let withdrawn = 0;
  for (const r of rows) {
    const repo = repoPath(repoRoot, r.ns_slug, r.skill_slug);
    if (!(await exists(repo))) {
      // No served repo at this root → nothing to delete here. Do NOT flip git_published
      // (that would falsely record the tag as withdrawn while it may still be served);
      // skip and re-check next sweep. In a correct single-root deployment a published
      // version's repo always exists, so this is just defensive.
      continue;
    }
    const tag = versionTag(r.semver);

    // Drop the version tag → the clone-by-ref fails.
    await git(["update-ref", "-d", `refs/tags/${tag}`], repo);

    // Reconcile `main` (the default branch a ref-less clone gets) with what remains: the next
    // latest-stable tag's commit — or, for a deprecated skill, the deprecation-hint commit on top
    // of it (§45.4) — or no `main` at all when nothing stable is left. Unconditional, so a `main`
    // that sat on a hint commit whose parent was the yanked tag is repaired too.
    const actives = (await pool.query<{ semver: string }>(
      `select semver from skill_versions where skill_id = $1 and status = 'active'`, [r.skill_id],
    )).rows.map((x) => x.semver);
    const latest = resolveLatest(actives);
    try {
      await ensureMain(repo, latest ? versionTag(latest) : null, await loadDeprecationState(pool, r.skill_id));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "withdraw: could not reconcile main", skill: `${r.ns_slug}/${r.skill_slug}`, err: String(err) }));
    }

    await pool.query(`update skill_versions set git_published = false where id = $1`, [r.id]);
    withdrawn++;
    console.log(JSON.stringify({ level: "info", msg: "withdrew yanked version", skill: `${r.ns_slug}/${r.skill_slug}`, version: r.semver }));
  }
  return withdrawn;
}
