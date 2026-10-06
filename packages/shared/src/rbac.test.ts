import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAccess,
  canReviewNamespace,
  canDirectPublish,
  isSkillVisible,
  canManageNamespaceSettings,
  canUseNamespaceMarketplace,
  seesViaGrantOnly,
  canShareSkill,
  canUnshareSkill,
} from "./rbac.js";
import type { RoleMapping } from "./types.js";

const NS_A = "ns-a";
const NS_B = "ns-b";

const mappings: RoleMapping[] = [
  { id: "1", groupId: "g-plat", namespaceId: null, role: "platform_admin" },
  { id: "2", groupId: "g-a-admin", namespaceId: NS_A, role: "namespace_admin" },
  { id: "3", groupId: "g-a-member", namespaceId: NS_A, role: "namespace_member" },
  { id: "4", groupId: "g-b-admin", namespaceId: NS_B, role: "namespace_admin" },
  { id: "5", groupId: "g-b-member", namespaceId: NS_B, role: "namespace_member" },
];
const NS_C = "ns-c";

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

// ── §42 sharing a restricted skill with other namespaces ──

test("§42 visibility: owner ∪ grantees; outsiders and revoked grantees see nothing", () => {
  const shared = { namespaceId: NS_A, visibility: "namespace" as const, sharedNamespaceIds: [NS_B] };
  const bMember = resolveAccess(new Set(["g-b-member"]), mappings);
  const aMember = resolveAccess(new Set(["g-a-member"]), mappings);
  const outsider = resolveAccess(new Set<string>(), mappings);
  const plat = resolveAccess(new Set(["g-plat"]), mappings);
  assert.equal(isSkillVisible(bMember, shared), true);
  assert.equal(isSkillVisible(aMember, shared), true);
  assert.equal(isSkillVisible(plat, shared), true);
  assert.equal(isSkillVisible(outsider, shared), false);
  // after revoke
  assert.equal(isSkillVisible(bMember, { ...shared, sharedNamespaceIds: [] }), false);
  // a grant to some OTHER namespace does not leak to B
  assert.equal(isSkillVisible(bMember, { ...shared, sharedNamespaceIds: [NS_C] }), false);
  // omitted list (an org skill path) behaves as no grants
  assert.equal(isSkillVisible(bMember, { namespaceId: NS_A, visibility: "namespace" }), false);
});

test("§42 marker: only a viewer whose access comes solely from a grant", () => {
  const shared = { namespaceId: NS_A, visibility: "namespace" as const, sharedNamespaceIds: [NS_B] };
  assert.equal(seesViaGrantOnly(resolveAccess(new Set(["g-b-member"]), mappings), shared), true);
  assert.equal(seesViaGrantOnly(resolveAccess(new Set(["g-a-member"]), mappings), shared), false);
  assert.equal(seesViaGrantOnly(resolveAccess(new Set(["g-a-member", "g-b-member"]), mappings), shared), false);
  assert.equal(seesViaGrantOnly(resolveAccess(new Set(["g-plat"]), mappings), shared), false);
  assert.equal(seesViaGrantOnly(resolveAccess(new Set(["g-b-member"]), mappings), { ...shared, visibility: "org" }), false);
});

test("§42 share authority: platform admin, owner-ns admin, explicit maintainer", () => {
  assert.equal(canShareSkill(resolveAccess(new Set(["g-plat"]), mappings), NS_A, false), true);
  assert.equal(canShareSkill(resolveAccess(new Set(["g-a-admin"]), mappings), NS_A, false), true);
  assert.equal(canShareSkill(resolveAccess(new Set(["g-a-member"]), mappings), NS_A, false), false);
  assert.equal(canShareSkill(resolveAccess(new Set(["g-a-member"]), mappings), NS_A, true), true);
  // a grantee-namespace admin may NOT add further grantees
  assert.equal(canShareSkill(resolveAccess(new Set(["g-b-admin"]), mappings), NS_A, false), false);
});

test("§42 unshare authority: the sharers plus the RECEIVING namespace's admin, for their own ns only", () => {
  const bAdmin = resolveAccess(new Set(["g-b-admin"]), mappings);
  assert.equal(canUnshareSkill(bAdmin, NS_A, NS_B, false), true);
  assert.equal(canUnshareSkill(bAdmin, NS_A, NS_C, false), false);
  assert.equal(canUnshareSkill(resolveAccess(new Set(["g-b-member"]), mappings), NS_A, NS_B, false), false);
  assert.equal(canUnshareSkill(resolveAccess(new Set(["g-a-admin"]), mappings), NS_A, NS_C, false), true);
  assert.equal(canUnshareSkill(resolveAccess(new Set(["g-a-member"]), mappings), NS_A, NS_C, true), true);
});
