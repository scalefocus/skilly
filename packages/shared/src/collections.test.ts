import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_EVICT_SQL,
  COLLECTION_NAME_MAX,
  collectionEligibleSql,
  collectionMatchSql,
  collectionMemberCountSql,
  collectionPath,
  isCollectionEligible,
  isCollectionId,
  likePattern,
  sameCollectionName,
  validateCollectionDescription,
  validateCollectionName,
} from "./collections.js";
import { achievementDef } from "./achievements.js";
import { MCP_TOOLS_READ, MCP_WRITE_TOOLS } from "./mcp.js";

test("name: trimmed, 1–60 characters counted as code points (§37.1)", () => {
  assert.deepEqual(validateCollectionName("  Onboarding pack  "), { ok: true, value: "Onboarding pack" });
  assert.equal(validateCollectionName("").ok, false);
  assert.equal(validateCollectionName("   ").ok, false);
  assert.equal(validateCollectionName(42).ok, false);
  assert.equal(validateCollectionName("x".repeat(COLLECTION_NAME_MAX)).ok, true);
  assert.equal(validateCollectionName("x".repeat(COLLECTION_NAME_MAX + 1)).ok, false);
  // 60 emoji are 120 UTF-16 units but 60 characters, as Postgres char_length counts them.
  assert.equal(validateCollectionName("📼".repeat(COLLECTION_NAME_MAX)).ok, true);
});

test("description: optional, blank becomes null, at most 500 characters (§37.1)", () => {
  assert.deepEqual(validateCollectionDescription(undefined), { ok: true, value: null });
  assert.deepEqual(validateCollectionDescription(null), { ok: true, value: null });
  assert.deepEqual(validateCollectionDescription("   "), { ok: true, value: null });
  assert.deepEqual(validateCollectionDescription(" For new joiners "), { ok: true, value: "For new joiners" });
  assert.equal(validateCollectionDescription("d".repeat(COLLECTION_DESCRIPTION_MAX)).ok, true);
  assert.equal(validateCollectionDescription("d".repeat(COLLECTION_DESCRIPTION_MAX + 1)).ok, false);
  assert.equal(validateCollectionDescription(7).ok, false);
});

test("names compare ignoring case and surrounding space — the unique-index rule", () => {
  assert.equal(sameCollectionName("Onboarding", " onboarding "), true);
  assert.equal(sameCollectionName("Onboarding", "Onboarding 2"), false);
});

test("eligibility: org-visible, active, with an installable version (§37.1)", () => {
  assert.equal(isCollectionEligible({ visibility: "org", archived: false, hasInstallableVersion: true }), true);
  assert.equal(isCollectionEligible({ visibility: "namespace", archived: false, hasInstallableVersion: true }), false);
  assert.equal(isCollectionEligible({ visibility: "org", archived: true, hasInstallableVersion: true }), false);
  assert.equal(isCollectionEligible({ visibility: "org", archived: false, hasInstallableVersion: false }), false);
  const sql = collectionEligibleSql("k");
  assert.match(sql, /k\.visibility = 'org'/);
  assert.match(sql, /k\.status = 'active'/);
  assert.match(sql, /ev\.status = 'active' and ev\.git_published/);
});

test("eviction keeps eligible skills and runs on one skill id (§37.4)", () => {
  assert.match(COLLECTION_EVICT_SQL, /delete from skill_collection_items/);
  assert.match(COLLECTION_EVICT_SQL, /i\.skill_id = \$1::uuid/);
  assert.match(COLLECTION_EVICT_SQL, /not exists/);
  assert.match(collectionMemberCountSql("c"), /ci\.collection_id = c\.id/);
});

test("matcher: escaped substring over name, description and owner; name hits rank first (§37.6)", () => {
  assert.equal(likePattern("50%_off" + "\\"), String.raw`%50\%\_off\\%`);
  const { text, values } = collectionMatchSql("  pack ", 3);
  assert.deepEqual(values, ["%pack%", 3]);
  assert.match(text, /c\.name ilike \$1/);
  assert.match(text, /coalesce\(c\.description, ''\) ilike \$1/);
  assert.match(text, /u\.status = 'active' and u\.erased_at is null/);
  assert.match(text, /m\.skill_count > 0/);
  assert.match(text, /order by m\.name_hit desc, m\.skill_count desc, m\.created_at desc/);
  assert.equal(collectionMatchSql("x", 999).values[1], 50, "the limit is clamped");
});

test("ids and links", () => {
  assert.equal(isCollectionId("8f14e45f-ceea-467a-9e1d-2f3c1a2b3c4d"), true);
  assert.equal(isCollectionId("not-a-uuid"), false);
  assert.equal(collectionPath("abc"), "/catalog?collection=abc");
});

test("Mixtape is a Contribute badge, and get_collections is a read-only MCP tool (§37.8 / §37.9)", () => {
  assert.equal(achievementDef("first_collection")?.name, "Mixtape");
  assert.equal(achievementDef("first_collection")?.group, "Contribute");
  assert.ok((MCP_TOOLS_READ as readonly string[]).includes("get_collections"));
  assert.equal(MCP_WRITE_TOOLS.has("get_collections"), false);
});
