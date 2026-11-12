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
      if (slug === "archived-skill") return { ...orgSkill, id: "s9", status: "archived" };
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
      // §69 agent keys — user-scoped: u1 is a member of NS_A, u2 of nothing.
      if (raw === "agent-member") return { userId: "u1", tokenId: "a1", type: "agent", isSystem: false } as TokenPrincipal;
      if (raw === "agent-outsider") return { userId: "u2", tokenId: "a2", type: "agent", isSystem: false } as TokenPrincipal;
      if (raw === "agent-inactive") return { userId: "u-gone", tokenId: "a3", type: "agent", isSystem: false, ownerInactive: true } as TokenPrincipal;
      if (raw === "agent-ownerless") return { userId: null, tokenId: "a4", type: "agent", isSystem: false } as TokenPrincipal;
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
  assert.deepEqual(d, { allow: false, status: 403, reason: "registry is read-only (push denied)", refusal: { code: "git_push_denied" } });
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
  assert.deepEqual(d, { allow: false, status: 403, reason: "not authorized for this namespace", refusal: { code: "install_token_not_visible", ownerUserId: "u2", tokenId: "t3" } });
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
    refusal: { code: "install_token_owner_inactive", ownerUserId: "u-gone", tokenId: "t5" },
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
    assert.deepEqual(d.refusal, { code: "install_token_owner_inactive", ownerUserId: "u-gone", tokenId: "t6" });
  }
});

test("token scoped to a different skill answers the SAME 404 as an unknown skill (§49.4)", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack", isServiceRpc: true },
    "good-org", // scoped to s1 (org-skill), presented against s2 (ns-skill)
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 404, reason: "skill not found", refusal: { code: "install_token_scope_mismatch", ownerUserId: "u1", tokenId: "t1" } });
});

test("unknown / archived skill is 404 for a valid token", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "missing", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    "good-ns",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 404, reason: "skill not found", refusal: { code: "install_token_scope_mismatch", ownerUserId: "u1", tokenId: "t2" } });
});

test("§49.4 ordering: the catalog is never consulted before the token — no anonymous existence oracle", async () => {
  // Unknown skill + no token ⇒ 401 (was 404), byte-identical to an existing skill + no token.
  const anon = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "missing", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    undefined,
    deps({ async findSkill() { throw new Error("findSkill must not be called without a token"); } }),
  );
  assert.deepEqual(anon, { allow: false, status: 401, reason: "authentication required" });
  // Unknown skill + bad token ⇒ the generic 401, recorded as install_token_invalid.
  const bad = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "missing", marketplace: null, operation: "upload-pack", isServiceRpc: false },
    "nope",
    deps({ async findSkill() { throw new Error("findSkill must not be called for an invalid token"); } }),
  );
  assert.deepEqual(bad, { allow: false, status: 401, reason: "invalid or expired token", refusal: { code: "install_token_invalid" } });
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
  assert.deepEqual(d, { allow: false, status: 403, reason: "registry is read-only (push denied)", refusal: { code: "git_push_denied" } });
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
  assert.deepEqual(mktAtSkill, { allow: false, status: 404, reason: "skill not found", refusal: { code: "install_token_scope_mismatch", ownerUserId: "u2", tokenId: "m1" } }); // §49.4: never a 403 that confirms the skill exists
});

// §42: a member of a namespace the restricted skill is SHARED with clones it with their own
// personal token; once the grant is revoked the same token is refused exactly like an outsider's.
test("namespace skill shared with another namespace: grantee member allowed, refused after revoke", async () => {
  const NS_B = "nsid-b";
  const granteeAccess = async () => resolveAccess(new Set(["g-b"]), [{ id: "m9", groupId: "g-b", namespaceId: NS_B, role: "namespace_member" }]);
  const req = { namespaceSlug: "team-a", skillSlug: "ns-skill", marketplace: null, operation: "upload-pack" as const, isServiceRpc: true };

  const shared = await authorizeGitRequest(req, "good-ns-outsider", deps({
    async findSkill() { return { ...nsSkill, sharedNamespaceIds: [NS_B] }; },
    resolveAccess: granteeAccess,
  }));
  assert.equal(shared.allow, true, "grantee member clones the shared skill");

  const revoked = await authorizeGitRequest(req, "good-ns-outsider", deps({
    async findSkill() { return { ...nsSkill, sharedNamespaceIds: [] }; },
    resolveAccess: granteeAccess,
  }));
  assert.deepEqual(revoked, { allow: false, status: 403, reason: "not authorized for this namespace", refusal: { code: "install_token_not_visible", ownerUserId: "u2", tokenId: "t3" } });
});

// ── §69 agent keys ─────────────────────────────────────────────────────────────────────────────
const skillReq = (slug: string, isServiceRpc = false) =>
  ({ namespaceSlug: "team-a", skillSlug: slug, marketplace: null, operation: "upload-pack" as const, isServiceRpc });

test("agent key: clones ANY visible skill — org-visible, and a restricted one of the owner's namespace", async () => {
  const org = await authorizeGitRequest(skillReq("org-skill"), "agent-member", deps());
  assert.equal(org.allow && org.kind === "skill" && org.skill.id, "s1");
  const ns = await authorizeGitRequest(skillReq("ns-skill", true), "agent-member", deps());
  assert.equal(ns.allow && ns.kind === "skill" && ns.skill.id, "s2");
  // An outsider's key still clones org-visible skills.
  assert.equal((await authorizeGitRequest(skillReq("org-skill"), "agent-outsider", deps())).allow, true);
});

test("agent key: restricted outside membership, archived and missing are ALL the same 404", async () => {
  const notFound = (tokenId: string, ownerUserId: string) =>
    ({ allow: false, status: 404, reason: "skill not found", refusal: { code: "agent_key_not_visible", ownerUserId, tokenId } });
  assert.deepEqual(await authorizeGitRequest(skillReq("ns-skill"), "agent-outsider", deps()), notFound("a2", "u2"));
  assert.deepEqual(await authorizeGitRequest(skillReq("archived-skill"), "agent-member", deps()), notFound("a1", "u1"));
  assert.deepEqual(await authorizeGitRequest(skillReq("no-such-skill"), "agent-member", deps()), notFound("a1", "u1"));
});

test("agent key: a skill shared with the owner's namespace (§42) is visible; revoking the grant hides it on the next request", async () => {
  const NS_B = "nsid-b";
  const granteeAccess = async () => resolveAccess(new Set(["g-b"]), [{ id: "m9", groupId: "g-b", namespaceId: NS_B, role: "namespace_member" }]);
  const shared = await authorizeGitRequest(skillReq("ns-skill"), "agent-outsider", deps({
    async findSkill() { return { ...nsSkill, sharedNamespaceIds: [NS_B] }; },
    resolveAccess: granteeAccess,
  }));
  assert.equal(shared.allow, true);
  const revoked = await authorizeGitRequest(skillReq("ns-skill"), "agent-outsider", deps({
    async findSkill() { return { ...nsSkill, sharedNamespaceIds: [] }; },
    resolveAccess: granteeAccess,
  }));
  assert.equal(revoked.allow === false && revoked.status, 404);
});

test("agent key: visibility is re-resolved on EVERY request, org-visible skills included", async () => {
  let resolved = 0;
  const counting = deps({ async resolveAccess(userId) { resolved++; return resolveAccess(userId === "u1" ? new Set(["g-a"]) : new Set(), mappings); } });
  await authorizeGitRequest(skillReq("org-skill"), "agent-member", counting);
  await authorizeGitRequest(skillReq("org-skill", true), "agent-member", counting);
  await authorizeGitRequest(skillReq("ns-skill"), "agent-member", counting);
  assert.equal(resolved, 3);
});

test("agent key: an inactive owner gets the generic 401; an ownerless row never authorizes", async () => {
  assert.deepEqual(await authorizeGitRequest(skillReq("org-skill"), "agent-inactive", deps()), {
    allow: false, status: 401, reason: "invalid or expired token", refusal: { code: "install_token_owner_inactive", ownerUserId: "u-gone", tokenId: "a3" },
  });
  const ownerless = await authorizeGitRequest(skillReq("org-skill"), "agent-ownerless", deps());
  assert.equal(ownerless.allow === false && ownerless.status, 401);
});

test("agent key: refused at a marketplace (403) and on push (403)", async () => {
  assert.deepEqual(await authorizeGitRequest(mktPath("_public")!, "agent-member", deps()), { allow: false, status: 403, reason: "token is scoped to a different marketplace" });
  const push = await authorizeGitRequest({ ...skillReq("org-skill", true), operation: "receive-pack" }, "agent-member", deps());
  assert.equal(push.allow === false && push.status, 403);
});

test("agent key: an install token is still bound to its own skill (unchanged)", async () => {
  // The agent branch must not widen install tokens: good-org (scoped to s1) still can't open s2.
  const d = await authorizeGitRequest(skillReq("ns-skill"), "good-org", deps());
  assert.equal(d.allow === false && d.status, 404);
});
