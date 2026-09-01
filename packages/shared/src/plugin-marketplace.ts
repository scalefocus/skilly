// Claude Code plugin-marketplace contract — PINNED, and deliberately SEPARATE from the
// `npx skills add` contract in external-tool.ts. SKILLY_SPEC.md §30; CLAUDE.md.
//
// skilly has two consumers. `vercel-labs/skills` clones ONE SKILL PER REPO with SKILL.md at the
// root (external-tool.ts). Claude Code instead adds a MARKETPLACE repo — a git repo carrying
// `.claude-plugin/marketplace.json` at its root, listing plugins, each of which is itself a
// directory carrying `.claude-plugin/plugin.json`. The two shapes have nothing in common, so
// neither module imports the other's wire format. Change the marketplace shape HERE and nowhere
// else.
//
// Topology (§30.1) — N+1 marketplaces, with DISJOINT contents:
//   • public      -> /_marketplace/_public.git  : every active ORG-visible skill, all namespaces
//   • per-namespace -> /_marketplace/<ns>.git   : that namespace's NAMESPACE-visibility skills only
// Visibility is enforced at the repo boundary (which repo you can get a token for), never by
// filtering inside a served file — see invariant #3 and §30.4.

/** Pinned contract metadata (mirrors EXTERNAL_TOOL_CONTRACT's role for the other consumer). */
export const MARKETPLACE_CONTRACT = {
  toolName: "Claude Code (/plugin marketplace add)",
  /** Claude Code release the shape below was verified against. */
  pinnedAtToolVersion: "2.1.229",
  /** How skilly serves a marketplace to the tool. */
  serveAs: "git-smart-http" as const,
  /** Auth mechanism: token as the git HTTP basic-auth password, same gateway as §9. */
  auth: "git-basic-auth-in-url" as const,
  /** Marketplace manifest location within the repo. */
  manifestPath: ".claude-plugin/marketplace.json",
  /** Per-plugin manifest location within a plugin directory. */
  pluginManifestPath: ".claude-plugin/plugin.json",
  /** Marketplace repos track the default branch only — versions are NOT tags here (§30.3). */
  ref: "main",
} as const;

/** First path segment of every marketplace repo. Starts with `_`, which no namespace or skill
 *  slug may (`^[a-z0-9][a-z0-9-]*$`), so a marketplace URL can never collide with `/<ns>/<skill>.git`. */
export const MARKETPLACE_PATH_PREFIX = "_marketplace";

/** Repo basename of the platform-wide public marketplace. `_`-led, so no namespace can shadow it. */
export const PUBLIC_MARKETPLACE_KEY = "_public";

/** Which marketplace a name/path/token refers to. */
export type MarketplaceScope = { kind: "public" } | { kind: "namespace"; namespaceSlug: string };

export const PUBLIC_SCOPE: MarketplaceScope = { kind: "public" };

/** Directory under the marketplace repo root holding the embedded plugins (§30.3). */
export const PLUGIN_ROOT = "plugins";

/** Default `marketplace_name_prefix` (§30.2). Platform-configurable so two skilly instances
 *  (dev + prod) don't collide on a name — Claude Code allows one marketplace per name per user. */
export const DEFAULT_MARKETPLACE_NAME_PREFIX = "skilly";

/**
 * Marketplace names Anthropic reserves for first-party use — a third party registering one is
 * rejected by Claude Code. This is the documented subset; the guard is advisory-but-cheap and its
 * failure mode without it (a silently unusable marketplace) is invisible to the admin. §30.2.
 */
export const RESERVED_MARKETPLACE_NAMES: readonly string[] = [
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "healthcare",
];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validate an admin-entered `marketplace_name_prefix`. Returns an error string, or null if ok. */
export function validateMarketplacePrefix(prefix: string): string | null {
  const p = prefix.trim();
  if (!p) return "prefix is required";
  if (p.length > 32) return "prefix must be at most 32 characters";
  if (!KEBAB.test(p)) return "prefix must be kebab-case (lowercase letters, digits and single hyphens)";
  return null;
}

/**
 * The public-facing `name` in marketplace.json: `<prefix>-<ns>`, or `<prefix>-public`.
 * This is what a consumer types in `/plugin install <plugin>@<name>`, and Claude Code allows a
 * user to register only ONE marketplace per name — hence the instance-discriminating prefix.
 */
export function marketplaceName(prefix: string, scope: MarketplaceScope): string {
  return scope.kind === "public" ? `${prefix}-public` : `${prefix}-${scope.namespaceSlug}`;
}

/** True when a computed marketplace name collides with Anthropic's reserved list (§30.2). */
export function isReservedMarketplaceName(name: string): boolean {
  return RESERVED_MARKETPLACE_NAMES.includes(name.toLowerCase());
}

/**
 * Every namespace slug whose computed marketplace name would be reserved under `prefix`
 * (plus the sentinel `null` entry when the PUBLIC marketplace's own name collides). Used to
 * reject a namespace create/rename and a prefix change with a 422 that names the offender.
 */
export function reservedNameConflicts(prefix: string, namespaceSlugs: readonly string[]): (string | null)[] {
  const out: (string | null)[] = [];
  if (isReservedMarketplaceName(marketplaceName(prefix, PUBLIC_SCOPE))) out.push(null);
  for (const slug of namespaceSlugs) {
    if (isReservedMarketplaceName(marketplaceName(prefix, { kind: "namespace", namespaceSlug: slug }))) out.push(slug);
  }
  return out;
}

/** Repo basename (without `.git`) for a marketplace: the namespace slug, or `_public`. */
export function marketplaceRepoKey(scope: MarketplaceScope): string {
  return scope.kind === "public" ? PUBLIC_MARKETPLACE_KEY : scope.namespaceSlug;
}

/** URL path of a marketplace repo, e.g. `/_marketplace/team-a.git`. */
export function marketplaceRepoUrlPath(scope: MarketplaceScope): string {
  return `/${MARKETPLACE_PATH_PREFIX}/${marketplaceRepoKey(scope)}.git`;
}

/** Parse a marketplace repo path back into its scope. Null when the path isn't one. */
export function parseMarketplaceRepoKey(prefixSegment: string, repoKey: string): MarketplaceScope | null {
  if (prefixSegment !== MARKETPLACE_PATH_PREFIX) return null;
  if (repoKey === PUBLIC_MARKETPLACE_KEY) return PUBLIC_SCOPE;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(repoKey)) return null;
  return { kind: "namespace", namespaceSlug: repoKey };
}

/** Git basic-auth username placeholder — the token is the password (same as §9). */
const TOKEN_USERNAME = "x-access-token";

export interface MarketplaceUrlInput {
  /** SKILLY_REGISTRY_URL, e.g. https://skilly.example.com */
  registryBaseUrl: string;
  scope: MarketplaceScope;
  /** The `marketplace` token, embedded as the git HTTP basic-auth PASSWORD (§30.4).
   *  SECURITY: the gateway MUST NOT log credentials. */
  token?: string;
}

/** The clone URL of a marketplace, with the token embedded when supplied. */
export function buildMarketplaceUrl(input: MarketplaceUrlInput): string {
  const u = new URL(input.registryBaseUrl);
  if (input.token) {
    u.username = TOKEN_USERNAME;
    u.password = input.token;
  }
  u.pathname = marketplaceRepoUrlPath(input.scope);
  return u.toString();
}

/** The copy-paste command a consumer runs in Claude Code. */
export function buildMarketplaceAddCommand(input: MarketplaceUrlInput): string {
  return `/plugin marketplace add ${buildMarketplaceUrl(input)}`;
}

/**
 * The credential-helper fallback (§30.4). Anthropic documents that Claude Code DISABLES git
 * credential helpers for background marketplace auto-updates and recommends a URL rewrite for
 * private marketplaces. Rewriting at the `_marketplace` prefix covers every marketplace on this
 * host with one line, so a consumer configures it once. Paired with `buildMarketplaceAddUrlPlain`.
 */
export function buildMarketplaceGitConfigCommand(input: MarketplaceUrlInput): string {
  const u = new URL(input.registryBaseUrl);
  const base = `${u.protocol}//${u.host}/${MARKETPLACE_PATH_PREFIX}`;
  const withCreds = `${u.protocol}//${TOKEN_USERNAME}:${input.token ?? "<token>"}@${u.host}/${MARKETPLACE_PATH_PREFIX}`;
  return `git config --global url."${withCreds}".insteadOf "${base}"`;
}

/** The credential-free add command, used together with the git-config rewrite above. */
export function buildMarketplaceAddCommandPlain(input: Omit<MarketplaceUrlInput, "token">): string {
  return buildMarketplaceAddCommand({ ...input, token: undefined });
}

// ---------------------------------------------------------------------------
// Manifest generation (§30.3)
// ---------------------------------------------------------------------------

export interface MarketplacePluginInput {
  /** Skill slug — becomes the plugin `name` and its directory under `plugins/`. Kebab-case. */
  skillSlug: string;
  title: string;
  description: string | null;
  /** The skill's latest STABLE semver. Claude Code only updates a plugin when this changes. */
  version: string;
  tags?: readonly string[];
  /** Primary category slug, or null. */
  category?: string | null;
  /** Absolute URL of the skill's detail page on this skilly. */
  homepage?: string | null;
  /** Plugin component files hoisted out of the bundle root — see planPluginLayout. */
  components?: PluginComponents;
}

export interface MarketplaceJsonInput {
  prefix: string;
  scope: MarketplaceScope;
  ownerName: string;
  ownerEmail?: string | null;
  description?: string;
  /** Synthesis serial — the content hash of this build, so a rebuilt manifest is self-describing. */
  version: string;
  plugins: readonly MarketplacePluginInput[];
}

export interface MarketplaceJson {
  name: string;
  owner: { name: string; email?: string };
  description: string;
  version: string;
  metadata: { pluginRoot: string };
  plugins: {
    name: string;
    source: string;
    displayName: string;
    description?: string;
    version: string;
    keywords?: string[];
    category?: string;
    homepage?: string;
  }[];
}

/** Build the marketplace manifest. Pure — the synthesis sweep serializes the result. */
export function buildMarketplaceJson(input: MarketplaceJsonInput): MarketplaceJson {
  const name = marketplaceName(input.prefix, input.scope);
  const owner: MarketplaceJson["owner"] = { name: input.ownerName };
  if (input.ownerEmail) owner.email = input.ownerEmail;
  return {
    name,
    owner,
    description:
      input.description ??
      (input.scope.kind === "public"
        ? "Skills available to everyone in this organization, published from skilly."
        : `Restricted skills from the ${input.ownerName} namespace on skilly.`),
    version: input.version,
    metadata: { pluginRoot: `./${PLUGIN_ROOT}` },
    plugins: input.plugins.map((p) => {
      const entry: MarketplaceJson["plugins"][number] = {
        name: p.skillSlug,
        source: `./${PLUGIN_ROOT}/${p.skillSlug}`,
        displayName: p.title,
        version: p.version,
      };
      if (p.description) entry.description = p.description;
      if (p.tags && p.tags.length > 0) entry.keywords = [...p.tags];
      if (p.category) entry.category = p.category;
      if (p.homepage) entry.homepage = p.homepage;
      return entry;
    }),
  };
}

export interface PluginJson {
  name: string;
  description?: string;
  version: string;
  skills: string[];
  commands?: string[];
  agents?: string[];
  hooks?: string;
  mcpServers?: string;
  lspServers?: string;
}

/** Build one plugin's manifest, wiring in whatever components the bundle carried (§30.3). */
export function buildPluginJson(p: MarketplacePluginInput): PluginJson {
  const out: PluginJson = { name: p.skillSlug, version: p.version, skills: [`./${SKILLS_DIR}/`] };
  if (p.description) out.description = p.description;
  const c = p.components;
  if (c?.hooks) out.hooks = "./hooks.json";
  if (c?.mcpServers) out.mcpServers = "./mcp.json";
  if (c?.lspServers) out.lspServers = "./lsp.json";
  if (c?.commands) out.commands = ["./commands/"];
  if (c?.agents) out.agents = ["./agents/"];
  return out;
}

// ---------------------------------------------------------------------------
// Plugin layout planning — the component hoist (§30.3)
// ---------------------------------------------------------------------------

/** Directory holding the skill itself inside a plugin. */
export const SKILLS_DIR = "skills";

/** Which recognized plugin components a bundle turned out to carry. */
export interface PluginComponents {
  hooks?: boolean;
  mcpServers?: boolean;
  lspServers?: boolean;
  commands?: boolean;
  agents?: boolean;
}

/** Bundle-root files that Claude Code reads as plugin components rather than skill content. */
const COMPONENT_FILES: Record<string, keyof PluginComponents> = {
  "hooks.json": "hooks",
  "mcp.json": "mcpServers",
  "lsp.json": "lspServers",
};

/** Bundle-root directories that Claude Code reads as plugin components. */
const COMPONENT_DIRS: Record<string, keyof PluginComponents> = {
  commands: "commands",
  agents: "agents",
};

export interface PluginLayout {
  /** bundlePath -> path relative to the PLUGIN directory. */
  moves: { from: string; to: string }[];
  components: PluginComponents;
}

/**
 * Map a skill bundle's files onto the plugin directory layout.
 *
 * A skilly bundle is `SKILL.md` at the root plus arbitrary files; a Claude Code plugin wants the
 * skill under `skills/<slug>/` and its COMPONENTS (`hooks.json`, `mcp.json`, `lsp.json`,
 * `commands/`, `agents/`) at the PLUGIN root. Left under `skills/<slug>/` those components would
 * be inert, so — per the approved §30.3 pass-through decision — recognized root components are
 * HOISTED to the plugin root and referenced from plugin.json; everything else moves under
 * `skills/<slug>/` unchanged.
 *
 * Pure and total: any path that isn't a recognized root component is skill content.
 */
export function planPluginLayout(skillSlug: string, paths: readonly string[]): PluginLayout {
  const moves: { from: string; to: string }[] = [];
  const components: PluginComponents = {};
  for (const raw of paths) {
    const path = raw.replace(/^\.?\//, "");
    if (!path) continue;
    const fileKey = COMPONENT_FILES[path];
    if (fileKey) {
      components[fileKey] = true;
      moves.push({ from: raw, to: path });
      continue;
    }
    const firstSeg = path.split("/")[0]!;
    const dirKey = path.includes("/") ? COMPONENT_DIRS[firstSeg] : undefined;
    if (dirKey) {
      components[dirKey] = true;
      moves.push({ from: raw, to: path });
      continue;
    }
    moves.push({ from: raw, to: `${SKILLS_DIR}/${skillSlug}/${path}` });
  }
  return { moves, components };
}

/** Prefix a plugin-relative path with its position in the marketplace repo. */
export function marketplaceRepoPath(skillSlug: string, pluginRelativePath: string): string {
  return `${PLUGIN_ROOT}/${skillSlug}/${pluginRelativePath}`;
}
