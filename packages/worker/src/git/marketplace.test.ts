// The marketplace commit ledger + repo layout (SKILLY_SPEC.md §30.5, §30.7). The commit trailers
// are a wire format — they are what the gateway reads to decide who gets credited for an install —
// so they get the same treatment as any other pinned format.
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
  changedSlugsSince,
  removeMarketplaceRepo,
} from "./marketplace.js";

const enc = (s: string) => new TextEncoder().encode(s);
const PUBLIC = { kind: "public" } as const;

test("commit message carries sorted trailers, and omits empty ones", () => {
  const msg = buildSyncCommitMessage("skilly-team-a", { added: ["b", "a"], updated: [], removed: ["z"] });
  assert.match(msg, /^skilly: marketplace sync skilly-team-a\n\n/);
  assert.match(msg, /^skilly-added: a b$/m);
  assert.match(msg, /^skilly-removed: z$/m);
  assert.equal(/skilly-updated:/.test(msg), false);
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

test("synthesis builds history, and the attribution cursor reads it back", async () => {
  const root = await mkdtemp(join(tmpdir(), "skilly-mkt-"));
  try {
    const dir = marketplaceRepoDir(root, PUBLIC);
    const manifest = { prefix: "skilly", scope: PUBLIC, ownerName: "skilly.test", version: "h1" };
    const plugin = (slug: string, version: string) => ({
      skillSlug: slug,
      title: slug,
      description: null,
      version,
      files: [{ path: "SKILL.md", bytes: enc(`# ${slug} ${version}\n`) }],
    });

    const c1 = await synthesizeMarketplace({
      bareRepoPath: dir,
      manifest,
      plugins: [plugin("a", "1.0.0")],
      change: { added: ["a"], updated: [], removed: [] },
      date: "2026-01-01T00:00:00Z",
    });
    assert.equal(await marketplaceHead(dir), c1);
    assert.deepEqual(await listedSlugs(dir), ["a"]);

    // A brand-new consumer (no cursor) is credited every listed skill.
    assert.deepEqual(await changedSlugsSince(dir, null), ["a"]);
    // A consumer already at head is credited nothing.
    assert.deepEqual(await changedSlugsSince(dir, c1), []);

    const c2 = await synthesizeMarketplace({
      bareRepoPath: dir,
      manifest: { ...manifest, version: "h2" },
      plugins: [plugin("a", "1.1.0"), plugin("b", "2.0.0")],
      change: { added: ["b"], updated: ["a"], removed: [] },
      date: "2026-01-02T00:00:00Z",
    });
    // Someone at c1 gets exactly what moved since: the updated `a` and the added `b`.
    assert.deepEqual((await changedSlugsSince(dir, c1)).sort(), ["a", "b"]);
    assert.deepEqual(await changedSlugsSince(dir, c2), []);

    // A skill added and then removed inside the range must NOT be credited to someone who never
    // received it — the credit set is intersected with what the marketplace still lists.
    await synthesizeMarketplace({
      bareRepoPath: dir,
      manifest: { ...manifest, version: "h3" },
      plugins: [plugin("a", "1.1.0")],
      change: { added: [], updated: [], removed: ["b"] },
      date: "2026-01-03T00:00:00Z",
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
