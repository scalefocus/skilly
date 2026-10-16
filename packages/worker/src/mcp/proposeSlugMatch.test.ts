// §8 slug match over MCP: a NEW-skill proposal whose slug a visible active skill in another namespace
// already uses is refused (naming the namespace to propose to instead); a new version of a skill in
// the target namespace never runs the cross-namespace check. Runs against the scriptable fake pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpProposal } from "./writes.js";
import { fakePool } from "./testPool.js";

const USER = "11111111-1111-1111-1111-111111111111";
const NS = { id: "ns-1", slug: "team" };
const MEMBER = { isPlatformAdmin: false, namespaceRoles: new Map([["ns-1", "namespace_member" as const]]) };
const SLUG_QUERY = "lower(s.slug) = $1";

function payload(skillSlug: string, whatChanged: string | null = null) {
  return {
    metadata: { skillSlug, title: "PDF Tools", description: "Work with PDFs.", visibility: "org" as const, toolHarness: "generic", categories: [], whatChanged },
    artifactObjectKey: "artifacts/pdf.tgz",
    artifactSha256: "sha",
  };
}

test("a new skill whose slug is taken elsewhere is refused with the namespace to use", async () => {
  const fp = fakePool();
  fp.on(SLUG_QUERY, [{ id: "s-9", namespace_slug: "data", slug: "pdf-tools", title: "PDF Tools", type: "hosted", deprecated: false }]);
  const r = await createMcpProposal(fp.pool, USER, MEMBER, NS, "1.0.0", payload("pdf-tools"), "Test Client");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /^slug_exists: .*data\/pdf-tools/);
  assert.match((r as { error: string }).error, /namespace "data"/);
  assert.equal(fp.matching("insert into proposals").length, 0, "no proposal is created");
});

test("the slug lookup is visibility-filtered with the caller's namespaces (invariant #3)", async () => {
  const fp = fakePool();
  fp.on("insert into proposals", [{ id: "p-1" }]);
  const r = await createMcpProposal(fp.pool, USER, MEMBER, NS, "1.0.0", payload("fresh-skill"), "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  const q = fp.matching(SLUG_QUERY)[0]!;
  assert.match(q.sql, /s\.visibility = 'org'/);
  assert.equal(q.params[0], "fresh-skill");
  assert.deepEqual(q.params[1], ["ns-1"]);
});

test("a new version of a skill in the target namespace skips the cross-namespace check", async () => {
  const fp = fakePool();
  fp.on("select s.id, s.status, s.namespace_id", [{ id: "skill-1", status: "active", namespace_id: "ns-1", visibility: "org", shared_namespace_ids: [] }]);
  fp.on("insert into proposals", [{ id: "p-2" }]);
  const r = await createMcpProposal(fp.pool, USER, MEMBER, NS, "1.1.0", payload("pdf-tools", "Better parsing."), "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fp.matching(SLUG_QUERY).length, 0);
});

test("a restricted skill the caller can't see is treated as absent — the new-skill path (§8 target visibility gate)", async () => {
  const fp = fakePool();
  const OUTSIDER = { isPlatformAdmin: false, namespaceRoles: new Map() };
  fp.on("select s.id, s.status, s.namespace_id", [{ id: "skill-1", status: "active", namespace_id: "ns-1", visibility: "namespace", shared_namespace_ids: ["ns-9"] }]);
  fp.on("insert into proposals", [{ id: "p-3" }]);
  const r = await createMcpProposal(fp.pool, USER, OUTSIDER, NS, "1.1.0", payload("pdf-tools"), "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r as { newSkill: boolean }).newSkill, true, "nothing about the hidden skill is confirmed");
  const ins = fp.matching("insert into proposals")[0]!;
  assert.equal(ins.params[1], null, "no target_skill_id — the hidden skill is never carried into the proposal");
  assert.equal(fp.matching(SLUG_QUERY).length, 1, "the ordinary new-skill slug check runs, visibility-filtered");
});

test("a member of the owning namespace still targets the restricted skill as a new version", async () => {
  const fp = fakePool();
  fp.on("select s.id, s.status, s.namespace_id", [{ id: "skill-1", status: "active", namespace_id: "ns-1", visibility: "namespace", shared_namespace_ids: [] }]);
  fp.on("insert into proposals", [{ id: "p-4" }]);
  const r = await createMcpProposal(fp.pool, USER, MEMBER, NS, "1.1.0", payload("pdf-tools", "Better parsing."), "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fp.matching("insert into proposals")[0]!.params[1], "skill-1");
});
