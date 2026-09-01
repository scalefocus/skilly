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
  buildMarketplaceJson,
  buildPluginJson,
  planPluginLayout,
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

test("marketplace.json carries pluginRoot and relative plugin sources", () => {
  const json = buildMarketplaceJson({
    prefix: DEFAULT_MARKETPLACE_NAME_PREFIX,
    scope: NS,
    ownerName: "Team A",
    ownerEmail: "team-a@example.com",
    version: "abc123",
    plugins: [
      {
        skillSlug: "pdf-tools",
        title: "PDF Tools",
        description: "Work with PDFs",
        version: "1.2.0",
        tags: ["pdf", "docs"],
        category: "productivity",
        homepage: "https://skilly.example.com/skills/team-a/pdf-tools",
      },
    ],
  });
  assert.equal(json.name, "skilly-team-a");
  assert.deepEqual(json.owner, { name: "Team A", email: "team-a@example.com" });
  assert.equal(json.metadata.pluginRoot, "./plugins");
  assert.equal(json.version, "abc123");
  assert.equal(json.plugins.length, 1);
  const p = json.plugins[0]!;
  assert.equal(p.name, "pdf-tools");
  assert.equal(p.source, "./plugins/pdf-tools");
  assert.equal(p.displayName, "PDF Tools");
  assert.equal(p.version, "1.2.0");
  assert.deepEqual(p.keywords, ["pdf", "docs"]);
  assert.equal(p.category, "productivity");
});

test("marketplace.json omits optional fields rather than emitting nulls", () => {
  const json = buildMarketplaceJson({
    prefix: "skilly",
    scope: PUBLIC_SCOPE,
    ownerName: "skilly.example.com",
    ownerEmail: null,
    version: "0",
    plugins: [{ skillSlug: "a", title: "A", description: null, version: "1.0.0" }],
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
  const bare = buildPluginJson({ skillSlug: "pdf-tools", title: "PDF Tools", description: "d", version: "1.0.0" });
  assert.deepEqual(bare.skills, ["./skills/"]);
  assert.equal(bare.name, "pdf-tools");
  assert.equal(bare.version, "1.0.0");
  assert.equal("hooks" in bare, false);
  assert.equal("mcpServers" in bare, false);

  const full = buildPluginJson({
    skillSlug: "x",
    title: "X",
    description: null,
    version: "2.0.0",
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
