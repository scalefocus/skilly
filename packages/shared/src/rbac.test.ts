import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAccess,
  canReviewNamespace,
  canDirectPublish,
  isSkillVisible,
} from "./rbac.js";
import type { RoleMapping } from "./types.js";

const NS_A = "ns-a";
const NS_B = "ns-b";

const mappings: RoleMapping[] = [
  { id: "1", groupId: "g-plat", namespaceId: null, role: "platform_admin" },
  { id: "2", groupId: "g-a-admin", namespaceId: NS_A, role: "namespace_admin" },
  { id: "3", groupId: "g-a-member", namespaceId: NS_A, role: "namespace_member" },
];

test("platform admin can review anywhere", () => {
  const a = resolveAccess(new Set(["g-plat"]), mappings);
  assert.ok(a.isPlatformAdmin);
  assert.ok(canReviewNamespace(a, NS_B));
});

test("namespace admin reviews own ns only", () => {
  const a = resolveAccess(new Set(["g-a-admin"]), mappings);
  assert.ok(canReviewNamespace(a, NS_A));
  assert.ok(!canReviewNamespace(a, NS_B));
});

test("member direct-publish gated by require_review", () => {
  const a = resolveAccess(new Set(["g-a-member"]), mappings);
  assert.ok(canDirectPublish(a, NS_A, false));
  assert.ok(!canDirectPublish(a, NS_A, true));
});

test("namespace-scoped skill hidden from outsiders", () => {
  const outsider = resolveAccess(new Set<string>(), mappings);
  assert.ok(isSkillVisible(outsider, { namespaceId: NS_A, visibility: "org" }));
  assert.ok(!isSkillVisible(outsider, { namespaceId: NS_A, visibility: "namespace" }));
  const member = resolveAccess(new Set(["g-a-member"]), mappings);
  assert.ok(isSkillVisible(member, { namespaceId: NS_A, visibility: "namespace" }));
});
