// Marketplace repo synthesis + the attribution ledger. SKILLY_SPEC.md §30.
//
// A marketplace repo is rebuilt WHOLE on every content change, as a new commit on top of the
// existing `main`. History is deliberately preserved: the §30.7 attribution cursor diffs a
// token's `last_served_commit` against the current head and reads which skills changed out of
// the commit messages in between, so the commit log IS the ledger.
//
// Plugins are CATEGORY groups (§30.3): plugins/<category-slug>/ (or plugins/general/), each
// carrying its member skills under skills/<skillDir>/ and the members' hoisted plugin components
// MERGED at the plugin root. The ledger stays skill-level: plugins are a delivery grouping.
import { mkdir, access, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MARKETPLACE_PATH_PREFIX,
  PLUGIN_ROOT,
  SKILLS_DIR,
  buildMarketplaceJson,
  buildPluginJson,
  isComponentPath,
  marketplaceRepoKey,
  mergeComponentJson,
  planPluginLayout,
  type MarketplaceJsonInput,
  type MarketplacePluginInput,
  type MarketplaceScope,
  type PluginComponents,
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
 * unambiguous. `notes` are free-text body lines for operators (plugin version bumps, §30.5);
 * the parser ignores them.
 */
export function buildSyncCommitMessage(marketplaceName: string, change: MarketplaceChange, notes: readonly string[] = []): string {
  const lines = [`skilly: marketplace sync ${marketplaceName}`, ""];
  for (const n of notes) lines.push(n.replace(/\r?\n/g, " "));
  if (notes.length > 0) lines.push("");
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

/** Machine-readable list of the skills a marketplace serves — feeds the next sweep's diff and the
 *  ledger's listed-set check (§30.5). Consumers ignore it. */
export const SKILLS_SIDECAR_PATH = ".skilly/skills.json";

export interface ServedSkill {
  namespaceSlug: string;
  skillSlug: string;
  semver: string;
}

/** One member skill's bytes, already placed by the grouper (§30.3). */
export interface MarketplaceMemberBuild {
  namespaceSlug: string;
  skillSlug: string;
  /** Directory under skills/ — the consumer-visible skill name. */
  skillDir: string;
  /** The skill bundle's files, paths relative to the BUNDLE root (SKILL.md at the root). */
  files: SkillFile[];
}

export interface MarketplacePluginBuild {
  /** The manifest entry, version already decided; `components` is filled in by synthesis. */
  entry: Omit<MarketplacePluginInput, "components">;
  members: MarketplaceMemberBuild[];
}

/** A hoisted component key/file two members both claimed — the first won (§30.3). */
export interface ComponentCollision {
  pluginSlug: string;
  /** `hooks.json` / `mcp.json` / `lsp.json`, or `commands` / `agents`. */
  component: string;
  /** The JSON key (`mcpServers.db`) or file path (`commands/review.md`) that was skipped. */
  key: string;
  winner: { namespaceSlug: string; skillSlug: string };
  skipped: { namespaceSlug: string; skillSlug: string };
}

export interface SynthesizeMarketplaceInput {
  bareRepoPath: string;
  manifest: Omit<MarketplaceJsonInput, "plugins">;
  plugins: MarketplacePluginBuild[];
  /** Every skill served, for the sidecar (§30.5). */
  served: ServedSkill[];
  change: MarketplaceChange;
  /** Operator-facing body lines (plugin bumps); never parsed. */
  notes?: string[];
  /** deterministic ISO date for author/committer (tests pass a fixed value) */
  date?: string;
}

const JSON_COMPONENT_FILES = new Set(["hooks.json", "mcp.json", "lsp.json"]);

/**
 * Rebuild a marketplace repo's `main` from the given plugin set, as a new commit parented on the
 * previous head (when there is one). Returns the new commit sha and every component collision.
 *
 * Layout (§30.3):
 *   .claude-plugin/marketplace.json
 *   .skilly/skills.json                              <- served-skill sidecar (ledger support)
 *   plugins/<category|general>/.claude-plugin/plugin.json
 *   plugins/<category|general>/skills/<skillDir>/…   <- each member's skill content
 *   plugins/<category|general>/{hooks,mcp,lsp}.json  <- merged hoisted components, when any
 *   plugins/<category|general>/{commands,agents}/…
 */
export async function synthesizeMarketplace(input: SynthesizeMarketplaceInput): Promise<{ commit: string; collisions: ComponentCollision[] }> {
  const { bareRepoPath, plugins } = input;

  if (!(await exists(bareRepoPath))) {
    await mkdir(bareRepoPath, { recursive: true });
    await runGit(["init", "--bare", "--initial-branch=main", bareRepoPath], {});
  }

  const files: SkillFile[] = [];
  const manifestPlugins: MarketplacePluginInput[] = [];
  const collisions: ComponentCollision[] = [];

  for (const p of plugins) {
    const pluginSlug = p.entry.slug;
    const components: PluginComponents = {};
    const jsonAcc = new Map<string, { value: unknown; owner: MarketplaceMemberBuild }>();
    const dirOwners = new Map<string, MarketplaceMemberBuild>();

    for (const m of p.members) {
      // Hoist recognized plugin components out of the bundle root; nest everything else under
      // skills/<skillDir>/. Under skills/ a hooks.json would be inert — see §30.3.
      const layout = planPluginLayout(m.skillDir, m.files.map((f) => f.path));
      for (const k of Object.keys(layout.components) as (keyof PluginComponents)[]) if (layout.components[k]) components[k] = true;
      const byPath = new Map(m.files.map((f) => [f.path, f]));
      for (const move of layout.moves) {
        const src = byPath.get(move.from);
        if (!src) continue;
        if (!isComponentPath(move.to)) {
          files.push({ path: `${PLUGIN_ROOT}/${pluginSlug}/${move.to}`, bytes: src.bytes, mode: src.mode });
          continue;
        }
        if (JSON_COMPONENT_FILES.has(move.to)) {
          // JSON components merge two levels deep; first wins on a clash (§30.3).
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(src.bytes));
          } catch {
            const cur = jsonAcc.get(move.to);
            collisions.push({ pluginSlug, component: move.to, key: "<unparseable JSON — skipped>", winner: who(cur?.owner ?? m), skipped: who(m) });
            continue;
          }
          const cur = jsonAcc.get(move.to);
          const { merged, skipped } = mergeComponentJson(cur?.value ?? null, parsed);
          for (const key of skipped) collisions.push({ pluginSlug, component: move.to, key, winner: who(cur!.owner), skipped: who(m) });
          jsonAcc.set(move.to, { value: merged, owner: cur?.owner ?? m });
          continue;
        }
        // commands/ and agents/ merge by file name; first wins on a clash (§30.3).
        const owner = dirOwners.get(move.to);
        if (owner) {
          collisions.push({ pluginSlug, component: move.to.split("/")[0]!, key: move.to, winner: who(owner), skipped: who(m) });
          continue;
        }
        dirOwners.set(move.to, m);
        files.push({ path: `${PLUGIN_ROOT}/${pluginSlug}/${move.to}`, bytes: src.bytes, mode: src.mode });
      }
    }

    for (const [name, { value }] of jsonAcc) files.push({ path: `${PLUGIN_ROOT}/${pluginSlug}/${name}`, bytes: json(value) });

    const entry: MarketplacePluginInput = { ...p.entry, components };
    manifestPlugins.push(entry);
    files.push({ path: `${PLUGIN_ROOT}/${pluginSlug}/.claude-plugin/plugin.json`, bytes: json(buildPluginJson(entry)) });
  }

  files.push({ path: ".claude-plugin/marketplace.json", bytes: json(buildMarketplaceJson({ ...input.manifest, plugins: manifestPlugins })) });
  files.push({ path: SKILLS_SIDECAR_PATH, bytes: json({ skills: [...input.served].sort(compareServed) }) });

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
  const args = ["commit-tree", treeSha, "-m", buildSyncCommitMessage(input.manifest.ownerName, input.change, input.notes ?? [])];
  if (parent) args.push("-p", parent);
  const commit = (await runGit(args, { gitDir: bareRepoPath, env })).trim();
  await runGit(["update-ref", "refs/heads/main", commit], { gitDir: bareRepoPath });
  return { commit, collisions };
}

function who(m: MarketplaceMemberBuild): { namespaceSlug: string; skillSlug: string } {
  return { namespaceSlug: m.namespaceSlug, skillSlug: m.skillSlug };
}

function compareServed(a: ServedSkill, b: ServedSkill): number {
  return a.namespaceSlug.localeCompare(b.namespaceSlug) || a.skillSlug.localeCompare(b.skillSlug);
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

/**
 * The skills the marketplace currently serves at `main`, from the sidecar. A repo written before
 * the category-plugin layout (skilly < 2.0.0) has no sidecar; its manifest listed one plugin per
 * skill, named by the skill slug, so the plugin list IS the served list — read that instead.
 */
export async function servedSkills(bareRepoPath: string): Promise<ServedSkill[]> {
  try {
    const raw = await runGit(["show", `main:${SKILLS_SIDECAR_PATH}`], { gitDir: bareRepoPath });
    const parsed = JSON.parse(raw) as { skills?: Partial<ServedSkill>[] };
    return (parsed.skills ?? []).filter((s): s is ServedSkill => typeof s.skillSlug === "string" && typeof s.semver === "string" && typeof s.namespaceSlug === "string");
  } catch {
    /* fall through to the legacy shape */
  }
  try {
    const raw = await runGit(["show", "main:.claude-plugin/marketplace.json"], { gitDir: bareRepoPath });
    const parsed = JSON.parse(raw) as { plugins?: { name?: unknown; version?: unknown }[] };
    return (parsed.plugins ?? [])
      .filter((p) => typeof p.name === "string" && typeof p.version === "string")
      .map((p) => ({ namespaceSlug: "", skillSlug: p.name as string, semver: p.version as string }));
  } catch {
    return [];
  }
}

/** Skill slugs currently served by the marketplace at `main` (the ledger's listed set). */
export async function listedSlugs(bareRepoPath: string): Promise<string[]> {
  return [...new Set((await servedSkills(bareRepoPath)).map((s) => s.skillSlug))];
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
