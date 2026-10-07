// `main` reconciliation for skill repos, deprecation-aware (SKILLY_SPEC.md §6 self-heal, §45.4).
//
// The expected `main` of a served skill repo is a pure function of the DB:
//   • not deprecated → the latest-stable tag's commit (the pre-§45 rule);
//   • deprecated     → ONE deterministic "deprecation notice" commit whose parent is that tag
//                      commit and whose only change is the root SKILL.md rewritten by
//                      `buildDeprecationHint` (frontmatter `deprecated: true` / `superseded_by`,
//                      a DEPRECATED description prefix, a banner). Fixed author/date/message, so
//                      the same inputs always yield the same SHA and the sweep can recompute and
//                      compare instead of tracking state. Tags are never touched (invariant #2).
//
// Steady state costs no git spawn: refs are read from the filesystem and the hint commit's SHA is
// cached in a marker file keyed by (base tag commit, hint inputs). Every writer of `main` — the
// publish sweep, the self-heal sweep, the yank withdrawal and the dedicated deprecation sync —
// goes through `ensureMain`, so no path can undo another's work.
import { createHash } from "node:crypto";
import { access, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { buildDeprecationHint, resolveLatest, versionTag } from "@skilly/shared";
import { runGit, type SkillFile } from "./synth.js";
import { repoPath } from "./repoStore.js";
import { publicBaseUrl } from "../mcp/url.js";

/** What the hint needs to know about a skill's deprecation (§45.4). */
export interface DeprecationHintState {
  deprecated: boolean;
  /** `<ns>/<slug>` of an ACTIVE successor, else null (none, archived, or deleted). */
  successor: string | null;
  note: string | null;
  /** The successor's catalog URL — never a clone URL, never a token. */
  successorUrl: string | null;
}

export const NOT_DEPRECATED: DeprecationHintState = { deprecated: false, successor: null, note: null, successorUrl: null };

/** Same fixed identity/date as tag synthesis (synth.ts) — determinism is the whole point. */
const COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "skilly",
  GIT_AUTHOR_EMAIL: "skilly@localhost",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "skilly",
  GIT_COMMITTER_EMAIL: "skilly@localhost",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
export const DEPRECATION_COMMIT_MESSAGE = "skilly: deprecation notice";
const MARKER_FILE = "skilly-deprecation-hint.json";

interface HintRow {
  deprecated_at: string | null;
  deprecation_note: string | null;
  succ_ns: string | null;
  succ_slug: string | null;
}

export function hintStateFromRow(r: HintRow): DeprecationHintState {
  if (!r.deprecated_at) return NOT_DEPRECATED;
  const successor = r.succ_ns && r.succ_slug ? `${r.succ_ns}/${r.succ_slug}` : null;
  return {
    deprecated: true,
    successor,
    note: r.deprecation_note,
    successorUrl: successor ? `${publicBaseUrl()}/skills/${successor}` : null,
  };
}

/** The hint inputs of one skill (an archived successor counts as absent, §45.3). */
export async function loadDeprecationState(pool: Pool, skillId: string): Promise<DeprecationHintState> {
  const { rows } = await pool.query<HintRow>(
    `select s.deprecated_at, s.deprecation_note, xn.slug as succ_ns, x.slug as succ_slug
       from skills s
       left join skills x on x.id = s.successor_skill_id and x.status = 'active'
       left join namespaces xn on xn.id = x.namespace_id
      where s.id = $1`,
    [skillId],
  );
  return rows[0] ? hintStateFromRow(rows[0]) : NOT_DEPRECATED;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Read a ref from the filesystem (loose file, else packed-refs). Null when absent. */
export async function readRefFs(bareRepoPath: string, ref: string): Promise<string | null> {
  try {
    const loose = (await readFile(join(bareRepoPath, ref), "utf8")).trim();
    if (/^[0-9a-f]{40}$/.test(loose)) return loose;
  } catch { /* not loose */ }
  try {
    const packed = await readFile(join(bareRepoPath, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp === 40 && line.slice(sp + 1).trim() === ref) return line.slice(0, 40);
    }
  } catch { /* no packed-refs */ }
  return null;
}

async function revParse(bareRepoPath: string, rev: string): Promise<string | null> {
  try {
    const out = (await runGit(["rev-parse", "--verify", "--quiet", rev], { gitDir: bareRepoPath })).trim();
    return out || null;
  } catch {
    return null;
  }
}

function inputsHash(state: DeprecationHintState): string {
  return createHash("sha256").update([state.successor ?? "", state.note ?? "", state.successorUrl ?? ""].join("\u001f")).digest("hex").slice(0, 16);
}

interface Marker { base: string; inputs: string; commit: string }

async function readMarker(bareRepoPath: string): Promise<Marker | null> {
  try {
    const m = JSON.parse(await readFile(join(bareRepoPath, MARKER_FILE), "utf8")) as Marker;
    return m && typeof m.commit === "string" ? m : null;
  } catch {
    return null;
  }
}

/**
 * The deprecation-hint commit for `tagCommit` (creating the objects if needed). Deterministic:
 * same tag commit + same inputs ⇒ same SHA. The SHA is cached in the marker file.
 */
export async function hintCommitFor(bareRepoPath: string, tagCommit: string, state: DeprecationHintState): Promise<string> {
  const inputs = inputsHash(state);
  const marker = await readMarker(bareRepoPath);
  if (marker && marker.base === tagCommit && marker.inputs === inputs && (await revParse(bareRepoPath, `${marker.commit}^{commit}`))) return marker.commit;

  const skillMd = await runGit(["show", `${tagCommit}:SKILL.md`], { gitDir: bareRepoPath });
  const rewritten = buildDeprecationHint(skillMd, { successor: state.successor, note: state.note, successorUrl: state.successorUrl });
  const blob = (await runGit(["hash-object", "-w", "--stdin"], { gitDir: bareRepoPath, input: Buffer.from(rewritten, "utf8") })).trim();
  // Root tree = the tag's root tree with the SKILL.md entry swapped.
  const listing = await runGit(["ls-tree", tagCommit], { gitDir: bareRepoPath });
  const lines = listing.split("\n").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    const name = l.slice(tab + 1);
    return name === "SKILL.md" ? `100644 blob ${blob}\tSKILL.md` : l;
  });
  const tree = (await runGit(["mktree"], { gitDir: bareRepoPath, input: Buffer.from(lines.join("\n") + "\n") })).trim();
  const commit = (await runGit(["commit-tree", tree, "-p", tagCommit, "-m", DEPRECATION_COMMIT_MESSAGE], { gitDir: bareRepoPath, env: COMMIT_ENV })).trim();
  await writeFile(join(bareRepoPath, MARKER_FILE), JSON.stringify({ base: tagCommit, inputs, commit } satisfies Marker));
  return commit;
}

export type EnsureMainOutcome = "unchanged" | "updated" | "deleted" | "missing-tag";

/**
 * Make `refs/heads/main` equal its expected commit (§6 self-heal rule, §45.4):
 *   latestStableTag null  → no stable version is served: delete `main` if present;
 *   not deprecated        → the tag's commit;
 *   deprecated            → the hint commit on top of the tag's commit.
 * "missing-tag" = the tag isn't synthesized yet; the caller re-synthesizes and calls again.
 */
export async function ensureMain(bareRepoPath: string, latestStableTag: string | null, state: DeprecationHintState): Promise<EnsureMainOutcome> {
  if (!(await exists(bareRepoPath))) return latestStableTag ? "missing-tag" : "unchanged";
  const cur = await readRefFs(bareRepoPath, "refs/heads/main");
  if (!latestStableTag) {
    if (cur) { await runGit(["update-ref", "-d", "refs/heads/main"], { gitDir: bareRepoPath }); return "deleted"; }
    return "unchanged";
  }
  // Tags are lightweight (synth.ts), so the ref IS the commit; fall back to rev-parse for safety.
  const tagCommit = (await readRefFs(bareRepoPath, `refs/tags/${latestStableTag}`)) ?? (await revParse(bareRepoPath, `refs/tags/${latestStableTag}^{commit}`));
  if (!tagCommit) return "missing-tag";
  const expected = state.deprecated ? await hintCommitFor(bareRepoPath, tagCommit, state) : tagCommit;
  if (!state.deprecated) await rm(join(bareRepoPath, MARKER_FILE), { force: true }).catch(() => {});
  if (cur === expected) return "unchanged";
  await runGit(["update-ref", "refs/heads/main", expected], { gitDir: bareRepoPath });
  return "updated";
}

/**
 * The dedicated deprecation sync (§45.4 "When"): every active skill with a served version gets its
 * `main` checked against the DB, so a (un)deprecation lands within one sweep regardless of the
 * self-heal batch window. Cheap: filesystem ref reads + a cached hint SHA; git runs only on change.
 * Returns the number of repos whose `main` moved. Also refreshes the deprecated-skills gauge.
 */
export async function syncDeprecationMains(pool: Pool, repoRoot: string, onGauge?: (deprecated: number) => void): Promise<number> {
  const { rows } = await pool.query<HintRow & { ns_slug: string; skill_slug: string; semvers: string[] | null }>(
    `select n.slug as ns_slug, s.slug as skill_slug, s.deprecated_at, s.deprecation_note, xn.slug as succ_ns, x.slug as succ_slug,
            array_remove(array_agg(sv.semver) filter (where sv.status = 'active' and sv.git_published), null) as semvers
       from skills s
       join namespaces n on n.id = s.namespace_id
       join skill_versions sv on sv.skill_id = s.id
       left join skills x on x.id = s.successor_skill_id and x.status = 'active'
       left join namespaces xn on xn.id = x.namespace_id
      where s.status = 'active'
      group by s.id, n.slug, xn.slug, x.slug
     having count(*) filter (where sv.status = 'active' and sv.git_published) > 0`,
  );
  let moved = 0;
  let deprecated = 0;
  for (const r of rows) {
    if (r.deprecated_at) deprecated++;
    const latest = resolveLatest(r.semvers ?? []);
    const repo = repoPath(repoRoot, r.ns_slug, r.skill_slug);
    try {
      const out = await ensureMain(repo, latest ? versionTag(latest) : null, hintStateFromRow(r));
      if (out === "updated" || out === "deleted") {
        moved++;
        console.log(JSON.stringify({ level: "info", msg: "main reconciled for deprecation state", skill: `${r.ns_slug}/${r.skill_slug}`, deprecated: !!r.deprecated_at, outcome: out }));
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "deprecation main sync failed", skill: `${r.ns_slug}/${r.skill_slug}`, err: String(err) }));
    }
  }
  onGauge?.(deprecated);
  return moved;
}

/**
 * The marketplace twin of the hint commit (§45.4): rewrite a member bundle's root SKILL.md the same
 * way before it is embedded under `skills/<skillDir>/`. No-op for a live skill.
 */
export function applyDeprecationHint(files: readonly SkillFile[], state: DeprecationHintState): SkillFile[] {
  if (!state.deprecated) return [...files];
  return files.map((f) =>
    f.path === "SKILL.md"
      ? { ...f, bytes: Buffer.from(buildDeprecationHint(Buffer.from(f.bytes).toString("utf8"), { successor: state.successor, note: state.note, successorUrl: state.successorUrl }), "utf8") }
      : f,
  );
}
