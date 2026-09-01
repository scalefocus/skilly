// Marketplace repo synthesis + the attribution ledger. SKILLY_SPEC.md §30.
//
// A marketplace repo is rebuilt WHOLE on every content change, as a new commit on top of the
// existing `main`. History is deliberately preserved: the §30.7 attribution cursor diffs a
// token's `last_served_commit` against the current head and reads which skills changed out of
// the commit messages in between, so the commit log IS the ledger.
import { mkdir, access, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MARKETPLACE_PATH_PREFIX,
  PLUGIN_ROOT,
  SKILLS_DIR,
  buildMarketplaceJson,
  buildPluginJson,
  marketplaceRepoKey,
  planPluginLayout,
  type MarketplaceJsonInput,
  type MarketplacePluginInput,
  type MarketplaceScope,
} from "@skilly/shared";
import { runGit, writeTree, type SkillFile } from "./synth.js";

/** Bare-repo path for a marketplace, under the same root as the skill repos.
 *  `_marketplace` and `_public` are `_`-led, so they can never collide with `<ns>/<slug>.git`. */
export function marketplaceRepoDir(root: string, scope: MarketplaceScope): string {
  const key = marketplaceRepoKey(scope);
  // Defence in depth: the key comes from a parsed slug, but this path is spawned into git.
  if (!/^(_public|[a-z0-9][a-z0-9-]*)$/.test(key)) throw new Error("invalid marketplace key");
  const p = resolve(join(root, MARKETPLACE_PATH_PREFIX, `${key}.git`));
  if (!p.startsWith(resolve(root))) throw new Error("path traversal blocked");
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The commit-message ledger (§30.7)
// ---------------------------------------------------------------------------

export interface MarketplaceChange {
  added: string[];
  updated: string[];
  removed: string[];
}

const TRAILER = { added: "skilly-added", updated: "skilly-updated", removed: "skilly-removed" } as const;

/**
 * Build a marketplace sync commit message. The trailers are machine-read by
 * `changedSlugsSince` — they are the attribution ledger, not decoration, so the format is
 * as pinned as any wire format. Slugs are `[a-z0-9-]+`, so a space-separated list is
 * unambiguous.
 */
export function buildSyncCommitMessage(marketplaceName: string, change: MarketplaceChange): string {
  const lines = [`skilly: marketplace sync ${marketplaceName}`, ""];
  for (const key of ["added", "updated", "removed"] as const) {
    const slugs = change[key];
    if (slugs.length > 0) lines.push(`${TRAILER[key]}: ${[...slugs].sort().join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse the added+updated slugs out of one or more concatenated commit messages. Removals credit
 * nothing (§30.7) and are ignored here. Unknown lines are ignored, so a hand-written or
 * future-format commit degrades to "credited nothing" rather than throwing.
 */
export function parseCreditedSlugs(commitMessages: string): string[] {
  const out = new Set<string>();
  for (const line of commitMessages.split("\n")) {
    const m = /^(skilly-added|skilly-updated):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    for (const slug of m[2]!.split(/\s+/)) {
      if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) out.add(slug);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface MarketplacePlugin extends MarketplacePluginInput {
  /** The skill bundle's files, paths relative to the BUNDLE root (SKILL.md at the root). */
  files: SkillFile[];
}

export interface SynthesizeMarketplaceInput {
  bareRepoPath: string;
  manifest: Omit<MarketplaceJsonInput, "plugins">;
  plugins: MarketplacePlugin[];
  change: MarketplaceChange;
  /** deterministic ISO date for author/committer (tests pass a fixed value) */
  date?: string;
}

/**
 * Rebuild a marketplace repo's `main` from the given plugin set, as a new commit parented on the
 * previous head (when there is one). Returns the new commit sha.
 *
 * Layout (§30.3):
 *   .claude-plugin/marketplace.json
 *   plugins/<slug>/.claude-plugin/plugin.json
 *   plugins/<slug>/skills/<slug>/…        <- skill content
 *   plugins/<slug>/{hooks,mcp,lsp}.json   <- hoisted components, when the bundle carried them
 *   plugins/<slug>/{commands,agents}/…
 */
export async function synthesizeMarketplace(input: SynthesizeMarketplaceInput): Promise<string> {
  const { bareRepoPath, plugins } = input;

  if (!(await exists(bareRepoPath))) {
    await mkdir(bareRepoPath, { recursive: true });
    await runGit(["init", "--bare", "--initial-branch=main", bareRepoPath], {});
  }

  const files: SkillFile[] = [];
  const manifestPlugins: MarketplacePluginInput[] = [];

  for (const p of plugins) {
    // Hoist recognized plugin components out of the bundle root; nest everything else under
    // skills/<slug>/. Under skills/<slug>/ a hooks.json would be inert — see §30.3.
    const layout = planPluginLayout(p.skillSlug, p.files.map((f) => f.path));
    const byPath = new Map(p.files.map((f) => [f.path, f]));
    for (const move of layout.moves) {
      const src = byPath.get(move.from);
      if (!src) continue;
      files.push({ path: `${PLUGIN_ROOT}/${p.skillSlug}/${move.to}`, bytes: src.bytes, mode: src.mode });
    }

    const entry: MarketplacePluginInput = { ...p, components: layout.components };
    delete (entry as { files?: unknown }).files;
    manifestPlugins.push(entry);

    files.push({
      path: `${PLUGIN_ROOT}/${p.skillSlug}/.claude-plugin/plugin.json`,
      bytes: json(buildPluginJson(entry)),
    });
  }

  files.push({
    path: ".claude-plugin/marketplace.json",
    bytes: json(buildMarketplaceJson({ ...input.manifest, plugins: manifestPlugins })),
  });

  const treeSha = await writeTree(bareRepoPath, files);

  let parent: string | null = null;
  try {
    parent = (await runGit(["rev-parse", "--verify", "refs/heads/main"], { gitDir: bareRepoPath })).trim();
  } catch {
    /* unborn main — this is the first sync */
  }

  const date = input.date ?? new Date().toISOString();
  const env: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: "skilly",
    GIT_AUTHOR_EMAIL: "skilly@localhost",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "skilly",
    GIT_COMMITTER_EMAIL: "skilly@localhost",
    GIT_COMMITTER_DATE: date,
  };
  const args = ["commit-tree", treeSha, "-m", buildSyncCommitMessage(input.manifest.ownerName, input.change)];
  if (parent) args.push("-p", parent);
  const commit = (await runGit(args, { gitDir: bareRepoPath, env })).trim();
  await runGit(["update-ref", "refs/heads/main", commit], { gitDir: bareRepoPath });
  return commit;
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

/** Current `main` commit of a marketplace repo, or null when unborn/absent. */
export async function marketplaceHead(bareRepoPath: string): Promise<string | null> {
  try {
    return (await runGit(["rev-parse", "--verify", "refs/heads/main"], { gitDir: bareRepoPath })).trim();
  } catch {
    return null;
  }
}

/** Plugin slugs currently listed in the marketplace manifest at `main`. */
export async function listedSlugs(bareRepoPath: string): Promise<string[]> {
  try {
    const raw = await runGit(["show", "main:.claude-plugin/marketplace.json"], { gitDir: bareRepoPath });
    const parsed = JSON.parse(raw) as { plugins?: { name?: unknown }[] };
    return (parsed.plugins ?? []).map((p) => p.name).filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/**
 * The skill slugs to credit for a fetch that advances a token from `fromCommit` to `main` (§30.7).
 *
 * - `fromCommit` null, unknown to this repo, or not an ancestor of main (the repo was rebuilt from
 *   scratch after a re-enable) => the consumer is effectively cloning fresh: credit EVERY listed
 *   skill.
 * - otherwise => credit the added/updated slugs recorded in the commits in between.
 * - already at main => nothing.
 */
export async function changedSlugsSince(bareRepoPath: string, fromCommit: string | null): Promise<string[]> {
  const head = await marketplaceHead(bareRepoPath);
  if (!head) return [];
  if (fromCommit === head) return [];

  if (fromCommit && (await isAncestor(bareRepoPath, fromCommit, head))) {
    const log = await runGit(["log", "--format=%B", `${fromCommit}..${head}`], { gitDir: bareRepoPath });
    // Only credit slugs the marketplace still lists — a skill added then removed across the range
    // must not be credited to someone who never received it.
    const listed = new Set(await listedSlugs(bareRepoPath));
    return parseCreditedSlugs(log).filter((s) => listed.has(s));
  }
  return listedSlugs(bareRepoPath);
}

async function isAncestor(gitDir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { gitDir });
    return true;
  } catch {
    return false; // unknown object, or not an ancestor — both mean "treat as a fresh clone"
  }
}

/** Delete a marketplace repo from disk (disable, §30.6). Idempotent. */
export async function removeMarketplaceRepo(root: string, scope: MarketplaceScope): Promise<void> {
  await rm(marketplaceRepoDir(root, scope), { recursive: true, force: true });
}

/** Re-exported for the sweep's layout assertions/tests. */
export const MARKETPLACE_LAYOUT = { PLUGIN_ROOT, SKILLS_DIR } as const;
