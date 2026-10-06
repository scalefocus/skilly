// §31.11 Encore over MCP: an MCP proposal for an EXISTING skill awards `first_version_proposal` in the
// proposal's own transaction; a brand-new-skill proposal does not. Runs against the scriptable fake
// pool, asserting on the award INSERT's key array (the same statement the web helper issues).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpProposal } from "./writes.js";
import { fakePool } from "./testPool.js";

const USER = "11111111-1111-1111-1111-111111111111";
const NS = { id: "ns-1", slug: "team" };

function payload(whatChanged: string | null) {
  return {
    metadata: {
      skillSlug: "encore-skill",
      title: "Encore Skill",
      description: "A skill used to test the Encore badge.",
      visibility: "org" as const,
      toolHarness: "generic",
      categories: [],
      whatChanged,
    },
    artifactObjectKey: "artifacts/encore.tgz",
    artifactSha256: "sha",
  };
}

/** The key arrays every user_achievements INSERT carried, flattened. */
function awardedKeys(fp: ReturnType<typeof fakePool>): string[] {
  return fp.matching("insert into user_achievements").flatMap((c) => c.params[1] as string[]);
}

test("MCP new-version proposal awards Encore alongside Homegrown (§31.11)", async () => {
  const fp = fakePool();
  fp.on("select id, status from skills", [{ id: "skill-1", status: "active" }]);
  fp.on("insert into proposals", [{ id: "p-1" }]);
  const r = await createMcpProposal(fp.pool, USER, NS, "1.1.0", payload("Faster and kinder."), "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  const keys = awardedKeys(fp);
  assert.ok(keys.includes("first_hosted_proposal"), "Homegrown still stacks");
  assert.ok(keys.includes("first_version_proposal"), "Encore awarded for a new version");
});

test("MCP new-skill proposal does not award Encore (§31.11)", async () => {
  const fp = fakePool();
  fp.on("insert into proposals", [{ id: "p-2" }]);
  const r = await createMcpProposal(fp.pool, USER, NS, "1.0.0", payload(null), "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  const keys = awardedKeys(fp);
  assert.ok(keys.includes("first_hosted_proposal"));
  assert.ok(!keys.includes("first_version_proposal"), "a brand-new skill is not a new version");
});
