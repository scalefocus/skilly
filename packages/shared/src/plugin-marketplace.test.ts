import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKETPLACE_PATH_PREFIX,
  PUBLIC_MARKETPLACE_KEY,
  PUBLIC_SCOPE,
  DEFAULT_MARKETPLACE_NAME_PREFIX,
  marketplaceName,
  isReservedMarketplaceName,
  reservedNameConflicts,
  RESERVED_MARKETPLACE_NAMES,
  validateMarketplacePrefix,
  marketplaceRepoKey,
  marketplaceRepoUrlPath,
  parseMarketplaceRepoKey,
  buildMarketplaceUrl,
  buildMarketplaceAddCommand,
  buildMarketplaceAddCommandPlain,
  buildMarketplaceGitConfigCommand,
  buildMarketplaceShellCommand,
  buildMarketplaceShellCommandPlain,
  buildMarketplaceSettingsSnippet,
  MARKETPLACE_ADD_ROUTES,
  MARKETPLACE_ADD_ROUTE_LABELS,
  DEFAULT_MARKETPLACE_ADD_ROUTE,
  parseMarketplaceAddRoute,
  buildMarketplaceJson,
  buildPluginJson,
  planPluginLayout,
  groupSkillsIntoPlugins,
  memberSkillDir,
  mergeComponentJson,
  pluginDescription,
  pluginHomepage,
  pluginKeywords,
  pluginVersion,
  isComponentPath,
  marketplaceRepoPath,
  type MarketplaceScope,
} from "./plugin-marketplace.js";

const NS: MarketplaceScope = { kind: "namespace", namespaceSlug: "team-a" };

test("marketplace names are prefix-scoped for public and namespace", () => {
  assert.equal(marketplaceName("skilly", PUBLIC_SCOPE), "skilly-public");
  assert.equal(marketplaceName("skilly", NS), "skilly-team-a");
  // the prefix is the instance discriminator (§30.2) — a dev instance gets its own names
  assert.equal(marketplaceName("skilly-dev", NS), "skilly-dev-team-a");
});

test("reserved-name guard fires on the COMPUTED name, not the raw slug", () => {
  // A namespace slugged `agent-skills` is harmless once prefixed...
  assert.equal(isReservedMarketplaceName("skilly-agent-skills"), false);
  assert.deepEqual(reservedNameConflicts("skilly", ["agent-skills", "team-a"]), []);
  // ...but an empty-ish prefix that reproduces a reserved name is caught.
  assert.equal(isReservedMarketplaceName("anthropic-plugins"), true);
  assert.deepEqual(reservedNameConflicts("anthropic", ["plugins", "team-a"]), ["plugins"]);
  // null is the sentinel for "the PUBLIC marketplace's own name collides"
  assert.deepEqual(reservedNameConflicts("healthcare-public", []), []);
  assert.deepEqual(reservedNameConflicts("healthcare", []).length, 0);
});

test("the public marketplace's name cannot collide under the shipped reserved list", () => {
  // reservedNameConflicts reports a public-name collision as the `null` sentinel. No entry in the
  // shipped list ends in `-public`, so no valid prefix can currently trip it — assert that rather
  // than contriving an unreachable case. The check stays because the list is Anthropic's, not ours,
  // and may grow; this test documents today's reachability, and will fail loudly if that changes.
  for (const reserved of RESERVED_MARKETPLACE_NAMES) {
    assert.equal(reserved.endsWith("-public"), false, `${reserved} would make the public name reachable`);
  }
  assert.deepEqual(reservedNameConflicts("skilly", []), []);
  assert.deepEqual(reservedNameConflicts("healthcare", []), []);
});

test("validateMarketplacePrefix enforces kebab-case and length", () => {
  assert.equal(validateMarketplacePrefix("skilly"), null);
  assert.equal(validateMarketplacePrefix("skilly-dev"), null);
  assert.equal(validateMarketplacePrefix("s1"), null);
  assert.match(validateMarketplacePrefix("") ?? "", /required/);
  assert.match(validateMarketplacePrefix("  ") ?? "", /required/);
  assert.match(validateMarketplacePrefix("Skilly") ?? "", /kebab-case/);
  assert.match(validateMarketplacePrefix("skilly_dev") ?? "", /kebab-case/);
  assert.match(validateMarketplacePrefix("skilly--dev") ?? "", /kebab-case/);
  assert.match(validateMarketplacePrefix("-skilly") ?? "", /kebab-case/);
  assert.match(validateMarketplacePrefix("a".repeat(33)) ?? "", /32 characters/);
});

test("repo keys and paths are collision-proof against skill repos", () => {
  assert.equal(marketplaceRepoKey(PUBLIC_SCOPE), PUBLIC_MARKETPLACE_KEY);
  assert.equal(marketplaceRepoKey(NS), "team-a");
  assert.equal(marketplaceRepoUrlPath(PUBLIC_SCOPE), "/_marketplace/_public.git");
  assert.equal(marketplaceRepoUrlPath(NS), "/_marketplace/team-a.git");
  // `_marketplace` and `_public` both start with `_`, which no slug may — so a skill can never
  // be served from a marketplace path and vice versa.
  assert.match(MARKETPLACE_PATH_PREFIX, /^_/);
  assert.match(PUBLIC_MARKETPLACE_KEY, /^_/);
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;
  assert.equal(SLUG.test(MARKETPLACE_PATH_PREFIX), false);
  assert.equal(SLUG.test(PUBLIC_MARKETPLACE_KEY), false);
});

test("parseMarketplaceRepoKey round-trips and rejects non-marketplace paths", () => {
  assert.deepEqual(parseMarketplaceRepoKey("_marketplace", "_public"), PUBLIC_SCOPE);
  assert.deepEqual(parseMarketplaceRepoKey("_marketplace", "team-a"), NS);
  // not the marketplace prefix -> not a marketplace request
  assert.equal(parseMarketplaceRepoKey("team-a", "pdf-tools"), null);
  // traversal / junk repo keys are refused
  assert.equal(parseMarketplaceRepoKey("_marketplace", ".."), null);
  assert.equal(parseMarketplaceRepoKey("_marketplace", "Team-A"), null);
  assert.equal(parseMarketplaceRepoKey("_marketplace", "_secret"), null);
});

test("install URL embeds the token as the basic-auth password", () => {
  const url = buildMarketplaceUrl({ registryBaseUrl: "https://skilly.example.com", scope: NS, token: "tok123" });
  assert.equal(url, "https://x-access-token:tok123@skilly.example.com/_marketplace/team-a.git");
  const plain = buildMarketplaceUrl({ registryBaseUrl: "https://skilly.example.com", scope: PUBLIC_SCOPE });
  assert.equal(plain, "https://skilly.example.com/_marketplace/_public.git");
});

test("add command and the credential-helper fallback", () => {
  const input = { registryBaseUrl: "https://skilly.example.com", scope: NS, token: "tok123" };
  assert.equal(
    buildMarketplaceAddCommand(input),
    "/plugin marketplace add https://x-access-token:tok123@skilly.example.com/_marketplace/team-a.git",
  );
  assert.equal(
    buildMarketplaceAddCommandPlain(input),
    "/plugin marketplace add https://skilly.example.com/_marketplace/team-a.git",
  );
  // The rewrite is scoped to the `_marketplace` prefix so ONE line covers every marketplace here.
  assert.equal(
    buildMarketplaceGitConfigCommand(input),
    'git config --global url."https://x-access-token:tok123@skilly.example.com/_marketplace".insteadOf "https://skilly.example.com/_marketplace"',
  );
});

test("Terminal route: the claude CLI subcommand, token-in-URL, with a credential-free twin", () => {
  const input = { registryBaseUrl: "https://skilly.example.com", scope: NS, token: "tok123" };
  assert.equal(
    buildMarketplaceShellCommand(input),
    "claude plugin marketplace add https://x-access-token:tok123@skilly.example.com/_marketplace/team-a.git",
  );
  assert.equal(
    buildMarketplaceShellCommandPlain(input),
    "claude plugin marketplace add https://skilly.example.com/_marketplace/team-a.git",
  );
  // The public marketplace resolves to the `_public` repo like every other builder.
  assert.equal(
    buildMarketplaceShellCommand({ ...input, scope: PUBLIC_SCOPE }),
    "claude plugin marketplace add https://x-access-token:tok123@skilly.example.com/_marketplace/_public.git",
  );
});

test("Settings-file route: extraKnownMarketplaces keyed by the manifest name, never carrying the token", () => {
  const snippet = buildMarketplaceSettingsSnippet({ registryBaseUrl: "https://skilly.example.com", scope: NS, name: "skilly-team-a" });
  const parsed = JSON.parse(snippet) as { extraKnownMarketplaces: Record<string, { source: { source: string; url: string } }> };
  assert.deepEqual(Object.keys(parsed.extraKnownMarketplaces), ["skilly-team-a"]);
  assert.deepEqual(parsed.extraKnownMarketplaces["skilly-team-a"]?.source, {
    source: "git",
    url: "https://skilly.example.com/_marketplace/team-a.git",
  });
  // Committed settings files must never carry a credential (§30.4 route 3).
  assert.equal(snippet.includes("x-access-token"), false);
  assert.equal(snippet.includes("tok"), false);
  // Pretty-printed so it pastes cleanly into a hand-edited settings file.
  assert.ok(snippet.includes("\n  \"extraKnownMarketplaces\""));
});

test("add routes: fixed order, Terminal default, untrusted values narrowed", () => {
  assert.deepEqual([...MARKETPLACE_ADD_ROUTES], ["terminal", "cli", "settings"]);
  assert.equal(DEFAULT_MARKETPLACE_ADD_ROUTE, "terminal");
  assert.deepEqual(MARKETPLACE_ADD_ROUTES.map((r) => MARKETPLACE_ADD_ROUTE_LABELS[r]), ["Terminal", "Claude CLI", "Settings file"]);
  assert.equal(parseMarketplaceAddRoute("cli"), "cli");
  assert.equal(parseMarketplaceAddRoute("settings"), "settings");
  assert.equal(parseMarketplaceAddRoute("desktop"), null);
  assert.equal(parseMarketplaceAddRoute(""), null);
  assert.equal(parseMarketplaceAddRoute(null), null);
  assert.equal(parseMarketplaceAddRoute(undefined), null);
});

test("marketplace.json carries pluginRoot and relative plugin sources — one plugin per category (§30.3)", () => {
  const json = buildMarketplaceJson({
    prefix: DEFAULT_MARKETPLACE_NAME_PREFIX,
    scope: NS,
    ownerName: "Team A",
    ownerEmail: "team-a@example.com",
    version: "abc123",
    plugins: [
      {
        slug: "productivity",
        displayName: "productivity",
        description: "2 skills in productivity from Team A",
        version: "1.0.3",
        keywords: ["PDF Tools", "pdf-tools", "Lint Fixer", "lint-fixer"],
        category: "productivity",
        homepage: "https://skilly.example.com/catalog?ns=team-a&category=productivity",
      },
    ],
  });
  assert.equal(json.name, "skilly-team-a");
  assert.deepEqual(json.owner, { name: "Team A", email: "team-a@example.com" });
  assert.equal(json.metadata.pluginRoot, "./plugins");
  assert.equal(json.version, "abc123");
  assert.equal(json.plugins.length, 1);
  const p = json.plugins[0]!;
  assert.equal(p.name, "productivity", "plugin name = category slug, no prefix");
  assert.equal(p.source, "./plugins/productivity");
  assert.equal(p.displayName, "productivity");
  assert.equal(p.version, "1.0.3");
  assert.deepEqual(p.keywords, ["PDF Tools", "pdf-tools", "Lint Fixer", "lint-fixer"], "keywords = member titles + slugs");
  assert.equal(p.category, "productivity");
  assert.equal(p.homepage, "https://skilly.example.com/catalog?ns=team-a&category=productivity");
});

test("marketplace.json omits optional fields rather than emitting nulls", () => {
  const json = buildMarketplaceJson({
    prefix: "skilly",
    scope: PUBLIC_SCOPE,
    ownerName: "skilly.example.com",
    ownerEmail: null,
    version: "0",
    plugins: [{ slug: "general", displayName: "general", description: null, version: "1.0.1" }],
  });
  assert.equal(json.name, "skilly-public");
  assert.equal("email" in json.owner, false);
  const p = json.plugins[0]!;
  assert.equal("description" in p, false);
  assert.equal("keywords" in p, false);
  assert.equal("category" in p, false);
  assert.equal("homepage" in p, false);
});

test("an empty marketplace still produces a valid manifest", () => {
  const json = buildMarketplaceJson({ prefix: "skilly", scope: NS, ownerName: "Team A", version: "0", plugins: [] });
  assert.deepEqual(json.plugins, []);
  assert.equal(json.name, "skilly-team-a");
});

test("plugin.json always points at ./skills/ and wires only present components", () => {
  const bare = buildPluginJson({ slug: "productivity", displayName: "productivity", description: "d", version: "1.0.1" });
  assert.deepEqual(bare.skills, ["./skills/"]);
  assert.equal(bare.name, "productivity");
  assert.equal(bare.version, "1.0.1");
  assert.equal("hooks" in bare, false);
  assert.equal("mcpServers" in bare, false);

  const full = buildPluginJson({
    slug: "x",
    displayName: "x",
    description: null,
    version: "1.0.2",
    components: { hooks: true, mcpServers: true, lspServers: true, commands: true, agents: true },
  });
  assert.equal(full.hooks, "./hooks.json");
  assert.equal(full.mcpServers, "./mcp.json");
  assert.equal(full.lspServers, "./lsp.json");
  assert.deepEqual(full.commands, ["./commands/"]);
  assert.deepEqual(full.agents, ["./agents/"]);
  assert.equal("description" in full, false);
});

test("planPluginLayout nests skill content and hoists recognized components", () => {
  const { moves, components } = planPluginLayout("pdf-tools", [
    "SKILL.md",
    "reference/guide.md",
    "hooks.json",
    "mcp.json",
    "lsp.json",
    "commands/review.md",
    "agents/helper.md",
  ]);
  const map = new Map(moves.map((m) => [m.from, m.to]));
  // skill content is nested under skills/<slug>/
  assert.equal(map.get("SKILL.md"), "skills/pdf-tools/SKILL.md");
  assert.equal(map.get("reference/guide.md"), "skills/pdf-tools/reference/guide.md");
  // components stay at the PLUGIN root — under skills/<slug>/ Claude Code would never read them
  assert.equal(map.get("hooks.json"), "hooks.json");
  assert.equal(map.get("mcp.json"), "mcp.json");
  assert.equal(map.get("lsp.json"), "lsp.json");
  assert.equal(map.get("commands/review.md"), "commands/review.md");
  assert.equal(map.get("agents/helper.md"), "agents/helper.md");
  assert.deepEqual(components, { hooks: true, mcpServers: true, lspServers: true, commands: true, agents: true });
});

test("planPluginLayout only hoists components at the bundle ROOT", () => {
  const { moves, components } = planPluginLayout("s", [
    "SKILL.md",
    "nested/hooks.json", // not a root component — ordinary content
    "commands", // a FILE named `commands`, not the directory — content
  ]);
  const map = new Map(moves.map((m) => [m.from, m.to]));
  assert.equal(map.get("nested/hooks.json"), "skills/s/nested/hooks.json");
  assert.equal(map.get("commands"), "skills/s/commands");
  assert.deepEqual(components, {});
});

test("planPluginLayout tolerates leading ./ and skips empty paths", () => {
  const { moves } = planPluginLayout("s", ["./SKILL.md", "", "./hooks.json"]);
  const map = new Map(moves.map((m) => [m.from, m.to]));
  assert.equal(map.get("./SKILL.md"), "skills/s/SKILL.md");
  assert.equal(map.get("./hooks.json"), "hooks.json");
  assert.equal(moves.length, 2);
});

test("marketplaceRepoPath places a plugin file under plugins/<slug>/", () => {
  assert.equal(marketplaceRepoPath("pdf-tools", "skills/pdf-tools/SKILL.md"), "plugins/pdf-tools/skills/pdf-tools/SKILL.md");
  assert.equal(marketplaceRepoPath("pdf-tools", ".claude-plugin/plugin.json"), "plugins/pdf-tools/.claude-plugin/plugin.json");
});

// ---------------------------------------------------------------------------
// Grouping (§30.3 membership rules) + component merging
// ---------------------------------------------------------------------------

const CATS = [
  { slug: "productivity", name: "productivity", description: null },
  { slug: "docs", name: "docs", description: "Writing and documents" },
];
const sk = (ns: string, slug: string, cats: string[], title = slug) => ({ namespaceSlug: ns, skillSlug: slug, title, categorySlugs: cats });

test("groupSkillsIntoPlugins: N categories → N plugins, none → general, empty categories → no plugin", () => {
  const { plugins, collisions } = groupSkillsIntoPlugins(NS, [
    sk("team-a", "pdf", ["productivity", "docs"]),
    sk("team-a", "lint", ["productivity"]),
    sk("team-a", "misc", []),
  ], CATS);
  assert.deepEqual(collisions, []);
  assert.deepEqual(plugins.map((p) => p.slug), ["docs", "productivity", "general"], "sorted by slug, general last");
  const by = new Map(plugins.map((p) => [p.slug, p]));
  assert.deepEqual(by.get("productivity")!.members.map((m) => m.skillDir), ["lint", "pdf"], "member order = (ns, slug); namespace dirs are bare slugs");
  assert.deepEqual(by.get("docs")!.members.map((m) => m.skillDir), ["pdf"]);
  assert.deepEqual(by.get("general")!.members.map((m) => m.skillDir), ["misc"], "uncategorized → general only");
  assert.equal(by.get("general")!.displayName, "general");
  assert.equal(by.get("docs")!.displayName, "docs");
  assert.equal(by.get("docs")!.categoryDescription, "Writing and documents");
});

test("groupSkillsIntoPlugins: general is omitted when every skill has a category; unknown slugs are ignored", () => {
  const { plugins } = groupSkillsIntoPlugins(NS, [sk("team-a", "pdf", ["docs", "ghost-category"])], CATS);
  assert.deepEqual(plugins.map((p) => p.slug), ["docs"]);
  const none = groupSkillsIntoPlugins(NS, [], CATS);
  assert.deepEqual(none.plugins, []);
});

test("groupSkillsIntoPlugins: public marketplace prefixes the namespace; directory collisions keep the first and are reported", () => {
  assert.equal(memberSkillDir(PUBLIC_SCOPE, "team-a", "deploy"), "team-a-deploy");
  assert.equal(memberSkillDir(NS, "team-a", "deploy"), "deploy");
  const { plugins, collisions } = groupSkillsIntoPlugins(PUBLIC_SCOPE, [
    sk("team-a", "deploy", ["productivity"]),
    sk("team", "a-deploy", ["productivity"]), // also → team-a-deploy
  ], CATS);
  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0]!.members.map((m) => `${m.namespaceSlug}/${m.skillSlug}`), ["team/a-deploy"], "first by (ns, slug) wins");
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]!.skillDir, "team-a-deploy");
  assert.equal(collisions[0]!.skipped.skillSlug, "deploy");
  assert.equal(collisions[0]!.winner.skillSlug, "a-deploy");
});

test("pluginDescription / pluginKeywords / pluginHomepage / pluginVersion follow §30.3", () => {
  const g = { slug: "productivity", displayName: "productivity", categoryDescription: null, members: [sk("team-a", "pdf", [], "PDF Tools"), sk("team-a", "lint", [], "Lint Fixer")] };
  assert.equal(pluginDescription(g, "Team A"), "2 skills in productivity from Team A");
  assert.equal(pluginDescription({ ...g, categoryDescription: " Own text " }, "Team A"), "Own text");
  assert.equal(pluginDescription({ slug: "general", displayName: "general", categoryDescription: null, members: [1] }, "skilly.example.com"), "1 skill without a category from skilly.example.com");
  assert.deepEqual(pluginKeywords(g.members), ["PDF Tools", "pdf", "Lint Fixer", "lint"]);
  assert.deepEqual(pluginKeywords([sk("a", "x", [], "x")]), ["x"], "title equal to slug is not duplicated");
  assert.equal(pluginHomepage("https://skilly.example.com", PUBLIC_SCOPE, g), "https://skilly.example.com/catalog?category=productivity");
  assert.equal(pluginHomepage("https://skilly.example.com/", NS, g, "Team A"), "https://skilly.example.com/catalog?ns=team-a&nsName=Team+A&category=productivity");
  assert.equal(pluginHomepage("https://skilly.example.com", NS, { slug: "general", displayName: "general" }, "Team A"), "https://skilly.example.com/catalog?ns=team-a&nsName=Team+A");
  assert.equal(pluginHomepage("", PUBLIC_SCOPE, g), null);
  assert.equal(pluginVersion(7), "1.0.7");
});

test("mergeComponentJson: entries merge by name, array entries concatenate, duplicates keep the first and are reported", () => {
  const a = { mcpServers: { db: { command: "a" }, web: { command: "w" } } };
  const b = { mcpServers: { db: { command: "b" }, cache: { command: "c" } }, lspServers: { ts: {} } };
  const r1 = mergeComponentJson(null, a);
  assert.deepEqual(r1, { merged: a, skipped: [] });
  const r2 = mergeComponentJson(r1.merged, b);
  assert.deepEqual(r2.skipped, ["mcpServers.db"]);
  assert.deepEqual(r2.merged, { mcpServers: { db: { command: "a" }, web: { command: "w" }, cache: { command: "c" } }, lspServers: { ts: {} } });

  const h1 = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [1] }] } };
  const h2 = { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [2] }], PostToolUse: [{ matcher: "*", hooks: [3] }] } };
  const h = mergeComponentJson(h1, h2);
  assert.deepEqual(h.skipped, []);
  assert.deepEqual(h.merged, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [1] }, { matcher: "Edit", hooks: [2] }], PostToolUse: [{ matcher: "*", hooks: [3] }] } });

  // A non-object root, or a scalar top-level clash, keeps the first and reports it.
  assert.deepEqual(mergeComponentJson({ a: 1 }, [1]).skipped, ["<root>"]);
  assert.deepEqual(mergeComponentJson({ version: 1 }, { version: 2 }).skipped, ["version"]);
});

test("isComponentPath recognizes hoisted files and directory members only", () => {
  assert.equal(isComponentPath("hooks.json"), true);
  assert.equal(isComponentPath("commands/review.md"), true);
  assert.equal(isComponentPath("skills/x/hooks.json"), false);
  assert.equal(isComponentPath("commands"), false);
});
