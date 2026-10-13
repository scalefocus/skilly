// §24 Replies over MCP: post_skill_comment's parentId is normalised to the thread's root, inherits
// the root's version, notifies the thread's people with the shared skill.discussion_reply statement,
// and keeps them out of the coalesced skill.discussion fan-out. Runs against the scriptable fake
// pool, asserting on the SQL parameters the write path issues.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { postSkillComment } from "./writes.js";
import { fakePool } from "./testPool.js";

const AUTHOR = "11111111-1111-1111-1111-111111111111";
const ROOT_AUTHOR = "22222222-2222-2222-2222-222222222222";
const REPLIER = "33333333-3333-3333-3333-333333333333";
const ROOT = "44444444-4444-4444-4444-444444444444";
const REPLY = "55555555-5555-5555-5555-555555555555";
const access = { isPlatformAdmin: false, namespaceRoles: new Map() } as unknown as EffectiveAccess;
const SKILL = { id: "skill-1", namespaceId: "ns-1", namespaceSlug: "team", skillSlug: "pdf", visibility: "org" as const };

function scripted(root: { removed?: boolean } = {}) {
  const fp = fakePool();
  fp.on("join messages r on r.id = coalesce(p.parent_id, p.id)", [
    { id: ROOT, author_id: ROOT_AUTHOR, context_semver: "1.2.0", removed_at: root.removed ? "2026-10-13T00:00:00Z" : null },
  ]);
  fp.on("select id from conversations", [{ id: "conv-1" }]);
  fp.on("insert into messages", [{ id: "new-msg", created_at: "2026-10-13T00:00:00Z" }]);
  fp.on("select author_id as user_id from messages", [{ user_id: ROOT_AUTHOR }, { user_id: REPLIER }, { user_id: AUTHOR }]);
  fp.on("select display_name from users", [{ display_name: "Ada" }]);
  return fp;
}

test("MCP reply: replying to a reply posts into the root's thread with the root's version (§24)", async () => {
  const fp = scripted();
  const r = await postSkillComment(fp.pool, access, AUTHOR, SKILL, "thanks!", null, "Test Client", REPLY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r as { parentId: string }).parentId, ROOT, "normalised to the root");
  const insert = fp.matching("insert into messages")[0]!;
  assert.equal(insert.params[3], "1.2.0", "the version pill is inherited from the root");
  assert.equal(insert.params[5], ROOT, "parent_id is the root, never the reply that was answered");
});

test("MCP reply: thread people get skill.discussion_reply and are excluded from skill.discussion (§12)", async () => {
  const fp = scripted();
  await postSkillComment(fp.pool, access, AUTHOR, SKILL, "thanks!", null, "Test Client", ROOT);
  const reply = fp.matching("'skill.discussion_reply'")[0];
  assert.ok(reply, "the reply fan-out ran");
  assert.deepEqual((reply.params[1] as string[]).sort(), [ROOT_AUTHOR, REPLIER].sort(), "the author is never a candidate");
  assert.equal(reply.params[3], ROOT_AUTHOR, "the renderer learns who wrote the root");
  const payload = JSON.parse(reply.params[2] as string) as { rootId: string; conversationId: string };
  assert.equal(payload.rootId, ROOT);
  const disc = fp.matching("'skill.discussion',")[0] ?? fp.matching("select r.uid, 'skill.discussion'")[0];
  assert.ok(disc, "the coalesced skill.discussion fan-out still runs for watchers and maintainers");
  assert.deepEqual((disc.params[4] as string[]).sort(), [ROOT_AUTHOR, REPLIER].sort(), "thread people get the reply row instead");
});

test("MCP reply: refused on a tombstone, with a contextSemver, or with a malformed id (§24)", async () => {
  const tomb = await postSkillComment(scripted({ removed: true }).pool, access, AUTHOR, SKILL, "hi", null, "Test Client", ROOT);
  assert.equal(tomb.ok, false);
  const both = await postSkillComment(scripted().pool, access, AUTHOR, SKILL, "hi", "1.2.0", "Test Client", ROOT);
  assert.equal(both.ok, false);
  const bad = await postSkillComment(scripted().pool, access, AUTHOR, SKILL, "hi", null, "Test Client", "not-a-uuid");
  assert.equal(bad.ok, false);
});

test("MCP top-level comment: no reply fan-out", async () => {
  const fp = scripted();
  fp.on("select semver from skill_versions", [{ semver: "1.2.0" }]);
  const r = await postSkillComment(fp.pool, access, AUTHOR, SKILL, "hello", "1.2.0", "Test Client");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fp.matching("'skill.discussion_reply'").length, 0);
  assert.equal(fp.matching("insert into messages")[0]!.params[5], null);
});
