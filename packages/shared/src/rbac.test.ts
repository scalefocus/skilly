import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAccess,
  canReviewNamespace,
  canDirectPublish,
  isSkillVisible,
  canManageNamespaceSettings,
  canUseNamespaceMarketplace,
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

test("canManageNamespaceSettings: platform admins anywhere, namespace admins in their own only", () => {
  const admin = resolveAccess(new Set(["g-plat"]), mappings);
  const nsAdmin = resolveAccess(new Set(["g-a-admin"]), mappings);
  const member = resolveAccess(new Set(["g-a-member"]), mappings);
  const nobody = resolveAccess(new Set(), mappings);

  assert.equal(canManageNamespaceSettings(admin, "ns-a"), true);
  assert.equal(canManageNamespaceSettings(admin, "ns-b"), true);
  assert.equal(canManageNamespaceSettings(nsAdmin, "ns-a"), true);
  // a namespace admin has no authority in a namespace they don't administer
  assert.equal(canManageNamespaceSettings(nsAdmin, "ns-b"), false);
  // members and outsiders never edit namespace settings
  assert.equal(canManageNamespaceSettings(member, "ns-a"), false);
  assert.equal(canManageNamespaceSettings(nobody, "ns-a"), false);
});

test("canUseNamespaceMarketplace: ANY role in the namespace, not just admin (§30.4)", () => {
  const admin = resolveAccess(new Set(["g-plat"]), mappings);
  const nsAdmin = resolveAccess(new Set(["g-a-admin"]), mappings);
  const member = resolveAccess(new Set(["g-a-member"]), mappings);
  const nobody = resolveAccess(new Set(), mappings);

  // A namespace marketplace carries the same restricted skills a member may already clone one by
  // one, so a member may add it — minting is gated on ACCESS, not on administering.
  assert.equal(canUseNamespaceMarketplace(member, "ns-a"), true);
  assert.equal(canUseNamespaceMarketplace(nsAdmin, "ns-a"), true);
  assert.equal(canUseNamespaceMarketplace(admin, "ns-a"), true);
  // ...but an outsider may not, and neither may a member of a different namespace.
  assert.equal(canUseNamespaceMarketplace(nobody, "ns-a"), false);
  assert.equal(canUseNamespaceMarketplace(member, "ns-b"), false);
});
