import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitPath,
  tokenFromAuthHeader,
  authorizeGitRequest,
  type GitAuthDeps,
  type SkillRef,
  type TokenPrincipal,
} from "./authorize.js";
import { resolveAccess, type RoleMapping } from "@skilly/shared";

const NS_A = "nsid-a";
const orgSkill: SkillRef = { id: "s1", namespaceId: NS_A, visibility: "org", status: "active" };
const nsSkill: SkillRef = { id: "s2", namespaceId: NS_A, visibility: "namespace", status: "active" };

const mappings: RoleMapping[] = [
  { id: "m1", groupId: "g-a", namespaceId: NS_A, role: "namespace_member" },
];

function deps(over: Partial<GitAuthDeps> = {}): GitAuthDeps {
  return {
    async findSkill(_ns, slug) {
      if (slug === "org-skill") return orgSkill;
      if (slug === "ns-skill") return nsSkill;
      return null;
    },
    async validateToken(raw) {
      // install tokens are skill-scoped; the scope must match the requested skill.
      if (raw === "good-org") return { userId: "u1", tokenId: "t1", type: "install", scopedSkillId: "s1", isSystem: false } as TokenPrincipal;
      if (raw === "good-ns") return { userId: "u1", tokenId: "t2", type: "install", scopedSkillId: "s2", isSystem: false } as TokenPrincipal;
      if (raw === "good-ns-outsider") return { userId: "u2", tokenId: "t3", type: "install", scopedSkillId: "s2", isSystem: false } as TokenPrincipal;
      // System installation: no user, skips the clone-time namespace re-check (§23).
      if (raw === "system-ns") return { userId: null, tokenId: "t4", type: "install", scopedSkillId: "s2", isSystem: true } as TokenPrincipal;
      // Owner-status gate (§5/§23): the token row matched but its owning user is inactive.
      if (raw === "inactive-org") return { userId: "u-gone", tokenId: "t5", type: "install", scopedSkillId: "s1", isSystem: false, ownerInactive: true } as TokenPrincipal;
      if (raw === "inactive-ns") return { userId: "u-gone", tokenId: "t6", type: "install", scopedSkillId: "s2", isSystem: false, ownerInactive: true } as TokenPrincipal;
      // Marketplace tokens (§30.4) — scoped to a marketplace, never to a skill.
      if (raw === "mkt-public") return { userId: "u2", tokenId: "m1", type: "marketplace", scopedMarketplace: { kind: "public" }, scopedNamespaceId: null, lastServedCommit: null, isSystem: false } as TokenPrincipal;
      if (raw === "mkt-ns") return { userId: "u1", tokenId: "m2", type: "marketplace", scopedMarketplace: { kind: "namespace", namespaceSlug: "team-a" }, scopedNamespaceId: NS_A, lastServedCommit: "abc", isSystem: false } as TokenPrincipal;
      if (raw === "mkt-ns-outsider") return { userId: "u2", tokenId: "m3", type: "marketplace", scopedMarketplace: { kind: "namespace", namespaceSlug: "team-a" }, scopedNamespaceId: NS_A, lastServedCommit: null, isSystem: false } as TokenPrincipal;
      if (raw === "mkt-other-ns") return { userId: "u1", tokenId: "m4", type: "marketplace", scopedMarketplace: { kind: "namespace", namespaceSlug: "team-b" }, scopedNamespaceId: "nsid-b", lastServedCommit: null, isSystem: false } as TokenPrincipal;
      return null;
    },
    async findMarketplace(scope) {
      if (scope.kind === "public") return { scope, namespaceId: null, enabled: true };
      if (scope.namespaceSlug === "team-a") return { scope, namespaceId: NS_A, enabled: true };
      if (scope.namespaceSlug === "team-off") return { scope, namespaceId: "nsid-off", enabled: false };
      return null;
    },
    async resolveAccess(userId) {
      // u1 is a member of group g-a (in NS_A); anyone else has no groups.
      return resolveAccess(userId === "u1" ? new Set(["g-a"]) : new Set(), mappings);
    },
    ...over,
  };
}

test("parses info/refs and rpc paths", () => {
  const a = parseGitPath("/team-a/pdf.git/info/refs", new URLSearchParams("service=git-upload-pack"));
  assert.deepEqual(a, { namespaceSlug: "team-a", skillSlug: "pdf", marketplace: null, operation: "upload-pack", isServiceRpc: false });
  const b = parseGitPath("/team-a/pdf.git/git-upload-pack", new URLSearchParams());
  assert.equal(b?.isServiceRpc, true);
  assert.equal(parseGitPath("/nope", new URLSearchParams()), null);
});

test("extracts token from basic auth header", () => {
  const h = "Basic " + Buffer.from("x-access-token:secret").toString("base64");
  assert.equal(tokenFromAuthHeader(h), "secret");
  assert.equal(tokenFromAuthHeader(undefined), undefined);
});

test("push is always denied", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "receive-pack", isServiceRpc: true },
    "good-ns",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "registry is read-only (push denied)" });
});

test("org skill requires a token (no anonymous clones)", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "org-skill", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    undefined,
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 401, reason: "authentication required" });
});

test("org skill: valid scoped token allowed", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "org-skill", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    "good-org",
    deps(),
  );
  assert.equal(d.allow, true);
});

test("namespace skill requires a token", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    undefined,
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 401, reason: "authentication required" });
});

test("namespace skill: member with valid token allowed", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: true },
    "good-ns",
    deps(),
  );
  assert.equal(d.allow, true);
});

test("namespace skill: outsider with valid token forbidden", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: true },
    "good-ns-outsider",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "not authorized for this namespace" });
});

test("namespace skill: SYSTEM token allowed without namespace access (deliberate admin grant)", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: true },
    "system-ns",
    deps({
      async resolveAccess() {
        throw new Error("resolveAccess must not be called for a system token");
      },
    }),
  );
  assert.equal(d.allow, true);
});

test("org skill: token of an inactive owner refused with the GENERIC invalid-token 401", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "org-skill", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    "inactive-org",
    deps(),
  );
  // Same reason string as a plain invalid token (no account-state oracle); the internal
  // ownerInactive marker is what drives the system_event record. §5/§23.
  assert.deepEqual(d, {
    allow: false,
    status: 401,
    reason: "invalid or expired token",
    ownerInactive: { ownerUserId: "u-gone" },
  });
});

test("namespace skill: inactive owner refused before any namespace re-check", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: true },
    "inactive-ns",
    deps({
      async resolveAccess() {
        throw new Error("resolveAccess must not be called for an inactive owner");
      },
    }),
  );
  assert.equal(d.allow, false);
  if (!d.allow) {
    assert.equal(d.status, 401);
    assert.equal(d.reason, "invalid or expired token");
    assert.deepEqual(d.ownerInactive, { ownerUserId: "u-gone" });
  }
});

test("token scoped to a different skill is forbidden", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: true },
    "good-org", // scoped to s1 (org-skill), presented against s2 (ns-skill)
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "token is scoped to a different skill" });
});

test("unknown / archived skill is 404", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "missing", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    "good-ns",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 404, reason: "skill not found" });
});

// ---------------------------------------------------------------------------
// Plugin marketplaces (SKILLY_SPEC.md §30)
// ---------------------------------------------------------------------------

const mktPath = (key: string) => parseGitPath(`/_marketplace/${key}.git/info/refs`, new URLSearchParams("service=git-upload-pack"));

test("marketplace paths parse into a scope, skill paths do not", () => {
  assert.deepEqual(mktPath("_public")?.marketplace, { kind: "public" });
  assert.deepEqual(mktPath("team-a")?.marketplace, { kind: "namespace", namespaceSlug: "team-a" });
  assert.equal(parseGitPath("/team-a/pdf.git/info/refs", new URLSearchParams("service=git-upload-pack"))?.marketplace, null);
});

test("an unresolvable _marketplace path is not a route at all", () => {
  // `_`-led first segments belong to the marketplace space; a junk key must 404, never fall
  // through and be treated as a skill repo named `..` in a namespace named `_marketplace`.
  assert.equal(mktPath(".."), null);
  assert.equal(mktPath("Team-A"), null);
  assert.equal(mktPath("_secret"), null);
});

test("push to a marketplace is denied like any other repo", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "_marketplace", skillSlug: "team-a", marketplace: { kind: "namespace", namespaceSlug: "team-a" }, operation: "receive-pack", isServiceRpc: true },
    "mkt-ns",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "registry is read-only (push denied)" });
});

test("a disabled or unknown marketplace is a 404 — never a 403 that confirms it exists", async () => {
  const off = await authorizeGitRequest(mktPath("team-off")!, "mkt-ns", deps());
  assert.deepEqual(off, { allow: false, status: 404, reason: "marketplace not found" });
  const missing = await authorizeGitRequest(mktPath("team-zzz")!, "mkt-ns", deps());
  assert.deepEqual(missing, { allow: false, status: 404, reason: "marketplace not found" });
});

test("a marketplace clone requires a token", async () => {
  const d = await authorizeGitRequest(mktPath("_public")!, undefined, deps());
  assert.deepEqual(d, { allow: false, status: 401, reason: "authentication required" });
});

test("any authenticated owner may clone the PUBLIC marketplace", async () => {
  // u2 has no namespace access at all — the public marketplace carries only org-visible skills,
  // so there is nothing to gate beyond holding a valid token (§30.4).
  const d = await authorizeGitRequest(mktPath("_public")!, "mkt-public", deps());
  assert.equal(d.allow, true);
  if (d.allow && d.kind === "marketplace") {
    assert.deepEqual(d.marketplace.scope, { kind: "public" });
    assert.equal(d.principal.lastServedCommit, null);
  }
});

test("a NAMESPACE marketplace re-checks the owner's access on every clone", async () => {
  const member = await authorizeGitRequest(mktPath("team-a")!, "mkt-ns", deps());
  assert.equal(member.allow, true);
  if (member.allow && member.kind === "marketplace") {
    assert.equal(member.marketplace.namespaceId, NS_A);
    assert.equal(member.principal.lastServedCommit, "abc");
  }
  // Same valid, unexpired, correctly-scoped token — but its owner is no longer in the namespace.
  const outsider = await authorizeGitRequest(mktPath("team-a")!, "mkt-ns-outsider", deps());
  assert.deepEqual(outsider, { allow: false, status: 403, reason: "not authorized for this namespace" });
});

test("a marketplace token is bound to its own marketplace", async () => {
  const wrongNs = await authorizeGitRequest(mktPath("team-a")!, "mkt-other-ns", deps());
  assert.deepEqual(wrongNs, { allow: false, status: 403, reason: "token is scoped to a different marketplace" });
  const publicAtNs = await authorizeGitRequest(mktPath("team-a")!, "mkt-public", deps());
  assert.deepEqual(publicAtNs, { allow: false, status: 403, reason: "token is scoped to a different marketplace" });
});

test("install and marketplace tokens are not interchangeable", async () => {
  // An install token must not open a marketplace...
  const installAtMkt = await authorizeGitRequest(mktPath("_public")!, "good-org", deps());
  assert.deepEqual(installAtMkt, { allow: false, status: 403, reason: "token is scoped to a different marketplace" });
  // ...and a marketplace token must not open a skill, not even an org-visible one.
  const mktAtSkill = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "org-skill", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    "mkt-public",
    deps(),
  );
  assert.deepEqual(mktAtSkill, { allow: false, status: 403, reason: "token is scoped to a different skill" });
});
