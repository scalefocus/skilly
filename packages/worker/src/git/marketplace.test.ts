// The marketplace commit ledger + repo layout (SKILLY_SPEC.md §30.3, §30.5, §30.7). The commit
// trailers are a wire format — they are what the gateway reads to decide who gets credited for an
// install — so they get the same treatment as any other pinned format. Plugins are CATEGORY groups:
// several member skills per plugin, their hoisted components merged at the plugin root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSyncCommitMessage,
  parseCreditedSlugs,
  marketplaceRepoDir,
  synthesizeMarketplace,
  marketplaceHead,
  listedSlugs,
  servedSkills,
  changedSlugsSince,
  removeMarketplaceRepo,
  SKILLS_SIDECAR_PATH,
  type MarketplacePluginBuild,
} from "./marketplace.js";
import { contentHash, diffChange, pluginFingerprint, marketplaceKey } from "./marketplaceSync.js";
import { runGit } from "./synth.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const PUBLIC = { kind: "public" } as const;

test("commit message carries sorted trailers, omits empty ones, and keeps notes out of the trailer block", () => {
  const msg = buildSyncCommitMessage("skilly-team-a", { added: ["b", "a"], updated: [], removed: ["z"] }, ["plugin productivity 1.0.1 -> 1.0.2"]);
  assert.match(msg, /^skilly: marketplace sync skilly-team-a\n\nplugin productivity 1\.0\.1 -> 1\.0\.2\n\n/);
  assert.match(msg, /^skilly-added: a b$/m);
  assert.match(msg, /^skilly-removed: z$/m);
  assert.equal(/skilly-updated:/.test(msg), false);
  // Notes are body text: the parser must not mistake them for credits.
  assert.deepEqual(parseCreditedSlugs(msg).sort(), ["a", "b"]);
});

test("parseCreditedSlugs takes added+updated and ignores removed", () => {
  const msg = buildSyncCommitMessage("m", { added: ["a"], updated: ["b"], removed: ["c"] });
  assert.deepEqual(parseCreditedSlugs(msg).sort(), ["a", "b"]);
});

test("parseCreditedSlugs dedupes across several commits and ignores junk", () => {
  const combined = [
    buildSyncCommitMessage("m", { added: ["a"], updated: [], removed: [] }),
    buildSyncCommitMessage("m", { added: [], updated: ["a", "b"], removed: [] }),
    "some hand-written commit\n\nskilly-added: NOT_A_SLUG ../etc\n",
  ].join("\n");
  assert.deepEqual(parseCreditedSlugs(combined).sort(), ["a", "b"]);
});

test("parseCreditedSlugs degrades to crediting nothing on an unknown format", () => {
  // A future or foreign commit format must not throw and must not guess — it credits nobody.
  assert.deepEqual(parseCreditedSlugs("Merge branch 'main'\n\nSigned-off-by: someone\n"), []);
  assert.deepEqual(parseCreditedSlugs(""), []);
});

test("marketplaceRepoDir refuses traversal and lands under the root", () => {
  const root = "/data/git";
  assert.match(marketplaceRepoDir(root, PUBLIC).replace(/\\/g, "/"), /_marketplace\/_public\.git$/);
  assert.match(marketplaceRepoDir(root, { kind: "namespace", namespaceSlug: "team-a" }).replace(/\\/g, "/"), /_marketplace\/team-a\.git$/);
  assert.throws(() => marketplaceRepoDir(root, { kind: "namespace", namespaceSlug: "../etc" }), /invalid marketplace key/);
  assert.throws(() => marketplaceRepoDir(root, { kind: "namespace", namespaceSlug: "Team-A" }), /invalid marketplace key/);
});

test("diffChange is skill-level: a regrouping without a version change credits nothing (§30.7)", () => {
  const prev = [{ namespaceSlug: "t", skillSlug: "a", semver: "1.0.0" }, { namespaceSlug: "t", skillSlug: "b", semver: "1.0.0" }];
  const next = [{ namespaceSlug: "t", skillSlug: "a", semver: "1.1.0" }, { namespaceSlug: "t", skillSlug: "c", semver: "2.0.0" }];
  assert.deepEqual(diffChange(prev, next), { added: ["c"], updated: ["a"], removed: ["b"] });
  assert.deepEqual(diffChange(null, next).added.sort(), ["a", "c"]);
  // Same skills, same versions — categories may have moved them between plugins; the ledger is silent.
  assert.deepEqual(diffChange(prev, prev), { added: [], updated: [], removed: [] });
});

test("contentHash moves on category-slug changes; pluginFingerprint ignores titles and is order-independent", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    skill_id: "id-a", slug: "a", title: "A", description: "d", artifact_object_key: "k", content_sha256: "sha-a",
    semver: "1.0.0", category_slugs: ["docs"], ns_slug: "t", ...over,
  });
  const base = contentHash([row()]);
  assert.notEqual(contentHash([row({ category_slugs: ["docs", "productivity"] })]), base, "membership change rebuilds");
  assert.notEqual(contentHash([row({ title: "B" })]), base, "a title edit rebuilds the manifest");
  assert.equal(contentHash([row(), row({ skill_id: "id-b", slug: "b" })]), contentHash([row({ skill_id: "id-b", slug: "b" }), row()]), "order-independent");

  const m1 = { skillDir: "a", skillId: "id-a", semver: "1.0.0", contentSha256: "sha-a" };
  const m2 = { skillDir: "b", skillId: "id-b", semver: "1.0.0", contentSha256: "sha-b" };
  const fp = pluginFingerprint([m1, m2], ["hooks.json"]);
  assert.equal(pluginFingerprint([m2, m1], ["hooks.json"]), fp, "member order does not matter");
  assert.notEqual(pluginFingerprint([m1, { ...m2, semver: "1.1.0" }], ["hooks.json"]), fp, "a member's new version bumps");
  assert.notEqual(pluginFingerprint([m1], ["hooks.json"]), fp, "a member leaving bumps");
  assert.notEqual(pluginFingerprint([m1, m2], []), fp, "a merged component file appearing/disappearing bumps");
  assert.equal(marketplaceKey(PUBLIC, null), "public");
  assert.equal(marketplaceKey({ kind: "namespace", namespaceSlug: "t" }, "uuid-1"), "ns:uuid-1");
});

/** A plugin build with member skills — SKILL.md plus whatever extra bundle files are given. */
function build(slug: string, version: string, members: { ns: string; slug: string; dir?: string; extra?: { path: string; body: string }[] }[]): MarketplacePluginBuild {
  return {
    entry: { slug, displayName: slug, description: `${members.length} skills`, version, category: slug === "general" ? null : slug },
    members: members.map((m) => ({
      namespaceSlug: m.ns,
      skillSlug: m.slug,
      skillDir: m.dir ?? m.slug,
      files: [{ path: "SKILL.md", bytes: enc(`# ${m.slug}\n`) }, ...(m.extra ?? []).map((e) => ({ path: e.path, bytes: enc(e.body) }))],
    })),
  };
}

test("synthesis lays out category plugins with member skills, merges components, and writes the sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "skilly-mkt-"));
  try {
    const dir = marketplaceRepoDir(root, PUBLIC);
    const manifest = { prefix: "skilly", scope: PUBLIC, ownerName: "skilly.test", version: "h1" };
    const mcpA = JSON.stringify({ mcpServers: { db: { command: "a" } } });
    const mcpB = JSON.stringify({ mcpServers: { db: { command: "b" }, cache: { command: "c" } } });
    const { commit, collisions } = await synthesizeMarketplace({
      bareRepoPath: dir,
      manifest,
      plugins: [
        build("productivity", "1.0.1", [
          { ns: "team-a", slug: "pdf", dir: "team-a-pdf", extra: [{ path: "mcp.json", body: mcpA }, { path: "commands/go.md", body: "A" }] },
          { ns: "team-b", slug: "lint", dir: "team-b-lint", extra: [{ path: "mcp.json", body: mcpB }, { path: "commands/go.md", body: "B" }, { path: "agents/h.md", body: "H" }] },
        ]),
        build("general", "1.0.1", [{ ns: "team-a", slug: "misc", dir: "team-a-misc" }]),
      ],
      served: [
        { namespaceSlug: "team-a", skillSlug: "pdf", semver: "1.0.0" },
        { namespaceSlug: "team-b", skillSlug: "lint", semver: "2.0.0" },
        { namespaceSlug: "team-a", skillSlug: "misc", semver: "0.1.0" },
      ],
      change: { added: ["pdf", "lint", "misc"], updated: [], removed: [] },
      date: "2026-01-01T00:00:00Z",
    });
    assert.equal(await marketplaceHead(dir), commit);

    // Two collisions, both first-wins: the `db` MCP server and the commands/go.md file.
    assert.deepEqual(
      collisions.map((c) => [c.pluginSlug, c.component, c.key, c.winner.skillSlug, c.skipped.skillSlug]),
      [["productivity", "mcp.json", "mcpServers.db", "pdf", "lint"], ["productivity", "commands", "commands/go.md", "pdf", "lint"]],
    );

    const show = (p: string) => runGit(["show", `main:${p}`], { gitDir: dir });
    const tree = (await runGit(["ls-tree", "-r", "--name-only", "main"], { gitDir: dir })).trim().split("\n").sort();
    assert.deepEqual(tree, [
      ".claude-plugin/marketplace.json",
      ".skilly/skills.json",
      "plugins/general/.claude-plugin/plugin.json",
      "plugins/general/skills/team-a-misc/SKILL.md",
      "plugins/productivity/.claude-plugin/plugin.json",
      "plugins/productivity/agents/h.md",
      "plugins/productivity/commands/go.md",
      "plugins/productivity/mcp.json",
      "plugins/productivity/skills/team-a-pdf/SKILL.md",
      "plugins/productivity/skills/team-b-lint/SKILL.md",
    ]);
    assert.equal((await show("plugins/productivity/commands/go.md")).trim(), "A", "first member's file kept");
    const mcp = JSON.parse(await show("plugins/productivity/mcp.json")) as { mcpServers: Record<string, { command: string }> };
    assert.deepEqual(mcp, { mcpServers: { db: { command: "a" }, cache: { command: "c" } } });

    const pj = JSON.parse(await show("plugins/productivity/.claude-plugin/plugin.json")) as Record<string, unknown>;
    assert.equal(pj.name, "productivity");
    assert.equal(pj.version, "1.0.1");
    assert.deepEqual(pj.skills, ["./skills/"]);
    assert.equal(pj.mcpServers, "./mcp.json");
    assert.deepEqual(pj.commands, ["./commands/"]);
    assert.deepEqual(pj.agents, ["./agents/"]);
    assert.equal("hooks" in pj, false);

    const mj = JSON.parse(await show(".claude-plugin/marketplace.json")) as { plugins: { name: string; source: string; category?: string }[] };
    assert.deepEqual(mj.plugins.map((p) => [p.name, p.source, p.category ?? null]), [["productivity", "./plugins/productivity", "productivity"], ["general", "./plugins/general", null]]);

    // The sidecar is the served-skill list the next sweep diffs against and the ledger checks.
    const side = JSON.parse(await show(SKILLS_SIDECAR_PATH)) as { skills: { skillSlug: string }[] };
    assert.deepEqual(side.skills.map((s) => s.skillSlug), ["misc", "pdf", "lint"], "sorted by (ns, slug)");
    assert.deepEqual((await servedSkills(dir)).map((s) => s.semver), ["0.1.0", "1.0.0", "2.0.0"]);
    assert.deepEqual((await listedSlugs(dir)).sort(), ["lint", "misc", "pdf"], "listed set = skills, not plugins");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dec helper sanity", () => {
  assert.equal(dec(enc("x")), "x");
});

test("attribution cursor reads skill-level credits back across category-plugin commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "skilly-mkt-"));
  try {
    const dir = marketplaceRepoDir(root, PUBLIC);
    const manifest = { prefix: "skilly", scope: PUBLIC, ownerName: "skilly.test", version: "h1" };
    const served1 = [{ namespaceSlug: "t", skillSlug: "a", semver: "1.0.0" }];
    const { commit: c1 } = await synthesizeMarketplace({
      bareRepoPath: dir, manifest, plugins: [build("docs", "1.0.1", [{ ns: "t", slug: "a", dir: "t-a" }])], served: served1,
      change: { added: ["a"], updated: [], removed: [] }, date: "2026-01-01T00:00:00Z",
    });
    // A brand-new consumer (no cursor) is credited every listed skill; one at head, nothing.
    assert.deepEqual(await changedSlugsSince(dir, null), ["a"]);
    assert.deepEqual(await changedSlugsSince(dir, c1), []);

    const served2 = [{ namespaceSlug: "t", skillSlug: "a", semver: "1.1.0" }, { namespaceSlug: "t", skillSlug: "b", semver: "2.0.0" }];
    const { commit: c2 } = await synthesizeMarketplace({
      bareRepoPath: dir, manifest: { ...manifest, version: "h2" },
      plugins: [build("docs", "1.0.2", [{ ns: "t", slug: "a", dir: "t-a" }, { ns: "t", slug: "b", dir: "t-b" }])], served: served2,
      change: diffChange(served1, served2), notes: ["plugin docs 1.0.1 -> 1.0.2"], date: "2026-01-02T00:00:00Z",
    });
    assert.deepEqual((await changedSlugsSince(dir, c1)).sort(), ["a", "b"]);
    assert.deepEqual(await changedSlugsSince(dir, c2), []);

    // A skill added then removed inside the range must NOT be credited to someone who never
    // received it — the credit set is intersected with what the marketplace still serves.
    const served3 = [{ namespaceSlug: "t", skillSlug: "a", semver: "1.1.0" }];
    await synthesizeMarketplace({
      bareRepoPath: dir, manifest: { ...manifest, version: "h3" },
      plugins: [build("docs", "1.0.3", [{ ns: "t", slug: "a", dir: "t-a" }])], served: served3,
      change: diffChange(served2, served3), date: "2026-01-03T00:00:00Z",
    });
    assert.deepEqual(await changedSlugsSince(dir, c1), ["a"]);
    // An unknown cursor (the repo was rebuilt after a re-enable) falls back to "fresh clone".
    assert.deepEqual(await changedSlugsSince(dir, "0".repeat(40)), ["a"]);

    await removeMarketplaceRepo(root, PUBLIC);
    assert.equal(await marketplaceHead(dir), null);
    assert.deepEqual(await changedSlugsSince(dir, null), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("servedSkills falls back to the legacy one-plugin-per-skill manifest when no sidecar exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "skilly-mkt-"));
  try {
    const dir = marketplaceRepoDir(root, PUBLIC);
    // Hand-build a pre-2.0.0 repo: manifest only, plugins named by skill slug.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await runGit(["init", "--bare", "--initial-branch=main", dir], {});
    const { writeTree } = await import("./synth.js");
    const legacy = { name: "skilly-public", plugins: [{ name: "pdf-tools", version: "1.2.0" }, { name: "lint", version: "0.9.0" }] };
    const tree = await writeTree(dir, [{ path: ".claude-plugin/marketplace.json", bytes: enc(JSON.stringify(legacy)) }]);
    const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const c = (await runGit(["commit-tree", tree, "-m", "legacy"], { gitDir: dir, env })).trim();
    await runGit(["update-ref", "refs/heads/main", c], { gitDir: dir });
    assert.deepEqual((await servedSkills(dir)).map((s) => [s.skillSlug, s.semver]), [["pdf-tools", "1.2.0"], ["lint", "0.9.0"]]);
    assert.deepEqual((await listedSlugs(dir)).sort(), ["lint", "pdf-tools"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
