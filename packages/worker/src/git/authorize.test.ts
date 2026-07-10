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
  assert.deepEqual(a, { namespaceSlug: "team-a", skillSlug: "pdf", operation: "upload-pack", isServiceRpc: false });
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
    { namespaceSlug: "team-a", skillSlug: "ns-skill", operation: "receive-pack", isServiceRpc: true },
    "good-ns",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "registry is read-only (push denied)" });
});

test("org skill requires a token (no anonymous clones)", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "org-skill", operation: "upload-pack", isServiceRpc: false },
    undefined,
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 401, reason: "authentication required" });
});

test("org skill: valid scoped token allowed", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "org-skill", operation: "upload-pack", isServiceRpc: false },
    "good-org",
    deps(),
  );
  assert.equal(d.allow, true);
});

test("namespace skill requires a token", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", operation: "upload-pack", isServiceRpc: false },
    undefined,
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 401, reason: "authentication required" });
});

test("namespace skill: member with valid token allowed", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", operation: "upload-pack", isServiceRpc: true },
    "good-ns",
    deps(),
  );
  assert.equal(d.allow, true);
});

test("namespace skill: outsider with valid token forbidden", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", operation: "upload-pack", isServiceRpc: true },
    "good-ns-outsider",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "not authorized for this namespace" });
});

test("namespace skill: SYSTEM token allowed without namespace access (deliberate admin grant)", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", operation: "upload-pack", isServiceRpc: true },
    "system-ns",
    deps({
      async resolveAccess() {
        throw new Error("resolveAccess must not be called for a system token");
      },
    }),
  );
  assert.equal(d.allow, true);
});

test("token scoped to a different skill is forbidden", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "ns-skill", operation: "upload-pack", isServiceRpc: true },
    "good-org", // scoped to s1 (org-skill), presented against s2 (ns-skill)
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 403, reason: "token is scoped to a different skill" });
});

test("unknown / archived skill is 404", async () => {
  const d = await authorizeGitRequest(
    { namespaceSlug: "team-a", skillSlug: "missing", operation: "upload-pack", isServiceRpc: false },
    "good-ns",
    deps(),
  );
  assert.deepEqual(d, { allow: false, status: 404, reason: "skill not found" });
});
