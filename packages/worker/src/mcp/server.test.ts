// Integration tests for the §29 MCP endpoint: the JSON-RPC surface, the auth posture, the
// templates-only resource list, and — the ones that matter most — the NEGATIVE visibility cases.
// A restricted skill must be invisible to an outsider through every door: search, detail, and every
// resource template (invariant #3).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { MCP_TOOL_NAMES, MCP_TOOL_CEILING } from "@skilly/shared";
import { mcpRouter } from "./server.js";
import { fakePool, authRows, type FakePool } from "./testPool.js";
import { invalidateMcpSettingsCache } from "./settings.js";
import { invalidateMcpRoleCache } from "./auth.js";
import { resetMcpRateLimits } from "./rateLimit.js";
import { bearerFromHeader } from "./auth.js";

const USER = "11111111-1111-1111-1111-111111111111";
const NS_MINE = "22222222-2222-2222-2222-222222222222";

function app(fp: FakePool) {
  const a = express();
  a.use(mcpRouter(fp.pool));
  return a;
}

/** A pool wired for an authenticated caller who is a member of ONE namespace (not an admin). */
function signedIn(opts: { enabled?: boolean } = {}): FakePool {
  const fp = fakePool();
  invalidateMcpSettingsCache();
  invalidateMcpRoleCache();
  resetMcpRateLimits();
  fp.on("from platform_settings", opts.enabled === false ? [{ key: "mcp_enabled", value: false }] : []);
  fp.on("from oauth_tokens t", authRows({ userId: USER }));
  // Group membership → one namespace_member role. Roles are resolved from the DB on every call.
  fp.on("from users u\n   left join group_memberships", [{ user_id: USER, group_oid: "oid-team" }]);
  fp.on("from role_mappings rm", [
    { id: "m1", namespace_id: NS_MINE, role: "namespace_member", group_id: "g1", group_oid: "oid-team" },
  ]);
  return fp;
}

const rpc = (fp: FakePool, body: unknown, token = "tok") =>
  request(app(fp)).post("/mcp").set("authorization", `Bearer ${token}`).send(body as object);

test("POST /mcp without a token → 401 pointing at the protected-resource metadata", async () => {
  const fp = signedIn();
  const res = await request(app(fp)).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(res.status, 401);
  assert.match(res.headers["www-authenticate"] ?? "", /resource_metadata=/);
});

test("an invalid token gets the SAME 401 as an expired / revoked / inactive-owner one", async () => {
  const bodies: string[] = [];
  for (const rows of [
    [], // unknown token
    authRows({ expired: true }),
    authRows({ grantRevoked: true }),
    authRows({ clientBlocked: true }),
    authRows({ userActive: false }),
  ]) {
    const fp = signedIn();
    fp.on("from oauth_tokens t", rows);
    const res = await rpc(fp, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(res.status, 401);
    bodies.push(JSON.stringify(res.body));
  }
  // No account-state or token-state oracle: every refusal is byte-identical to the client.
  assert.equal(new Set(bodies).size, 1, `expected one response shape, got ${bodies.join(" | ")}`);
});

test("initialize advertises tools + resources and names the server", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.serverInfo.name, "skilly");
  assert.equal(res.body.result.protocolVersion, "2025-06-18");
  assert.ok(res.body.result.capabilities.tools);
  assert.match(res.body.result.instructions, /search_skills/);
});

test("tools/list exposes exactly the 25 curated tools, with read-only hints", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = res.body.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
  assert.equal(tools.length, MCP_TOOL_CEILING);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...MCP_TOOL_NAMES].sort(),
  );
  const search = tools.find((t) => t.name === "search_skills")!;
  assert.equal(search.annotations.readOnlyHint, true);
  const install = tools.find((t) => t.name === "install_skill")!;
  assert.equal(install.annotations.readOnlyHint, false);
  // §37.9 agents read collections; people curate them.
  const collections = tools.find((t) => t.name === "get_collections")!;
  assert.equal(collections.annotations.readOnlyHint, true);
});

test("no tool exists for the excluded surface (review decisions, admin, destruction)", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).join(" ");
  for (const banned of ["accept", "reject", "request_changes", "admin", "erase", "audit", "yank", "archive", "publish"]) {
    assert.equal(names.includes(banned), false, `tools/list must not offer anything named "${banned}"`);
  }
});

test("resources/list advertises TEMPLATES ONLY — the catalog is never enumerated", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.deepEqual(res.body.result.resources, []);
  const templates = res.body.result.resourceTemplates as Array<{ uriTemplate: string }>;
  assert.equal(templates.length, 3);
  for (const t of templates) assert.match(t.uriTemplate, /\{namespace\}/);
  // And nothing in the response names a concrete skill.
  assert.equal(fp.matching("from skills").length, 0, "resources/list must not query the catalog at all");
});

test("an unknown tool is a tool-level error the model can recover from, not a transport failure", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /tools\/list/);
});

test("an unknown JSON-RPC method is a proper method-not-found error", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 6, method: "wat/nope" });
  assert.equal(res.body.error.code, -32601);
});

test("notifications get no response body", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
});

test("prompts/list is empty rather than an error (v1 exposes no prompts)", async () => {
  const fp = signedIn();
  const res = await rpc(fp, { jsonrpc: "2.0", id: 7, method: "prompts/list" });
  assert.deepEqual(res.body.result.prompts, []);
});

// ── The toggle ─────────────────────────────────────────────────────────────────────────────────

test("with MCP disabled, /mcp answers 503 and never authenticates", async () => {
  const fp = signedIn({ enabled: false });
  const res = await rpc(fp, { jsonrpc: "2.0", id: 8, method: "ping" });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /disabled/i);
  // The kill-switch short-circuits BEFORE the token lookup — nothing about the caller is read.
  assert.equal(fp.matching("from oauth_tokens").length, 0);
});

test("GET /mcp explains the transport instead of 404-ing", async () => {
  const fp = signedIn();
  const res = await request(app(fp)).get("/mcp");
  assert.equal(res.status, 405);
  assert.match(res.body.error, /Streamable HTTP/);
});

// ── Invariant #3: the negative visibility cases ────────────────────────────────────────────────

test("search_skills binds the caller's namespaces into the visibility predicate", async () => {
  const fp = signedIn();
  fp.on("from skills s", []);
  fp.on("count(*)::text as total", [{ total: "0" }]);
  await rpc(fp, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_skills", arguments: { query: "pdf" } } });

  const q = fp.matching("from skills s").find((c) => c.sql.includes("array_remove"));
  assert.ok(q, "search must query the catalog");
  // The predicate itself, from the ONE shared implementation.
  assert.match(q!.sql, /s\.visibility = 'org' or s\.namespace_id = any/);
  // …bound to exactly the namespaces this caller is a member of, and nothing else.
  assert.ok(
    q!.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === NS_MINE),
    `expected the caller's namespace ids to be bound; got ${JSON.stringify(q!.params)}`,
  );
});

const COLLECTION = "33333333-3333-4333-8333-333333333333";
const callCollections = (fp: FakePool, args: Record<string, unknown>) =>
  rpc(fp, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "get_collections", arguments: args } });

test("get_collections with an id: members run the eligibility AND the caller's visibility predicate (§37.9 / invariant #3)", async () => {
  const fp = signedIn();
  fp.on("from skill_collections c join users u", [
    { id: COLLECTION, name: "Onboarding pack", description: null, skill_count: 1, created_at: new Date("2026-10-01T00:00:00Z"), owner_name: "Ada" },
  ]);
  fp.on("from skill_collection_items ci\n       join skills s", [{ namespace_slug: "team", slug: "pdf", title: "PDF", versions: ["1.0.0", "1.1.0"] }]);
  const res = await callCollections(fp, { id: COLLECTION });
  assert.equal(res.body.result.isError, undefined);
  const body = JSON.parse(res.body.result.content[0].text);
  assert.equal(body.name, "Onboarding pack");
  assert.equal(body.owner, "Ada");
  assert.match(body.link, /\/catalog\?collection=33333333-/);
  assert.deepEqual(body.skills, [{ namespace: "team", slug: "pdf", title: "PDF", latestInstallable: "1.1.0" }]);

  const q = fp.matching("from skill_collection_items ci").find((c) => c.sql.includes("join namespaces n"));
  assert.ok(q, "the member query must run");
  assert.match(q!.sql, /s\.visibility = 'org' and s\.status = 'active'/, "eligibility predicate");
  assert.match(q!.sql, /s\.visibility = 'org' or s\.namespace_id = any/, "the shared visibility predicate");
  assert.ok(q!.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === NS_MINE), "bound to the caller's namespaces");
});

test("get_collections: unknown id and a too-short query are tool errors; no arguments lists your own", async () => {
  const fp = signedIn();
  const missing = await callCollections(fp, { id: COLLECTION });
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /no collection with that id/);

  const short = await callCollections(fp, { query: "a" });
  assert.equal(short.body.result.isError, true);

  fp.on("from skill_collections c where c.owner_id = $1", [
    { id: COLLECTION, name: "Mine", description: "d", skill_count: 0, created_at: new Date("2026-10-01T00:00:00Z") },
  ]);
  const own = await callCollections(fp, {});
  const body = JSON.parse(own.body.result.content[0].text);
  assert.equal(body.collections.length, 1);
  assert.equal(body.collections[0].skillCount, 0);
  const q = fp.matching("from skill_collections c where c.owner_id = $1")[0];
  assert.equal(q!.params[0], USER, "scoped to the caller");
});

test("get_collections with a query runs the shared matcher (name, description, owner; active owners; non-empty)", async () => {
  const fp = signedIn();
  fp.on("as name_hit", [{ id: COLLECTION, name: "Onboarding pack", description: null, skill_count: 3, created_at: new Date("2026-10-01T00:00:00Z"), owner_name: "Ada" }]);
  const res = await callCollections(fp, { query: "onboard" });
  const body = JSON.parse(res.body.result.content[0].text);
  assert.equal(body.collections[0].owner, "Ada");
  const q = fp.matching("as name_hit")[0]!;
  assert.equal(q.params[0], "%onboard%");
  assert.equal(q.params[1], 10);
  assert.match(q.sql, /m\.skill_count > 0/);
});

test("get_skill on a skill the caller can't see is indistinguishable from a missing one", async () => {
  const fp = signedIn();
  // findVisibleSkill returns nothing — that's what a restricted skill looks like to an outsider.
  fp.on("from skills s join namespaces n on n.id = s.namespace_id\n      where", []);
  const res = await rpc(fp, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "get_skill", arguments: { namespace: "secret", slug: "thing" } },
  });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /isn't visible to you/);
  // Crucially: the same message as a genuinely absent skill, and no detail query ran.
  assert.equal(fp.matching("skill_maintainers sm join users").length, 0);
});

test("a resource read of an invisible skill fails the same way, and never touches storage", async () => {
  const fp = signedIn();
  fp.on("from skills s join namespaces n on n.id = s.namespace_id\n      where", []);
  const res = await rpc(fp, {
    jsonrpc: "2.0",
    id: 11,
    method: "resources/read",
    params: { uri: "skilly://skill/secret/thing" },
  });
  assert.match(String(res.body.error.message), /isn't visible to you/);
  assert.equal(fp.matching("from skill_versions").length, 0, "must not read versions of an invisible skill");
});

test("a malformed resource URI is refused before any lookup", async () => {
  const fp = signedIn();
  const res = await rpc(fp, {
    jsonrpc: "2.0",
    id: 12,
    method: "resources/read",
    params: { uri: "skilly://skill/acme/deploy@1.0.0/../../etc/passwd" },
  });
  assert.match(String(res.body.error.message), /not a skilly resource URI/);
  assert.equal(fp.matching("from skills").length, 0);
});

// ── Install: the system flag is unreachable ────────────────────────────────────────────────────

test("install_skill refuses a `system` flag outright — that path is platform-admin only", async () => {
  const fp = signedIn();
  const res = await rpc(fp, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "install_skill", arguments: { namespace: "global", slug: "thing", system: true } },
  });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /platform-admin only/);
  // It fails before minting anything.
  assert.equal(fp.matching("insert into tokens").length, 0);
});

// ── Rate limiting ──────────────────────────────────────────────────────────────────────────────

test("a tool over its per-minute ceiling is refused as a tool error naming the retry delay", async () => {
  const fp = signedIn();
  fp.on("from skill_requests r", []);
  // request_skill's ceiling mirrors the web route's (10/min).
  let last: { body: { result: { isError?: boolean; content: Array<{ text: string }> } } } | null = null;
  for (let i = 0; i < 12; i++) {
    last = (await rpc(fp, {
      jsonrpc: "2.0",
      id: 100 + i,
      method: "tools/call",
      params: { name: "request_skill", arguments: { title: "x", description: "y", toolHarness: "generic" } },
    })) as never;
  }
  assert.equal(last!.body.result.isError, true);
  assert.match(last!.body.result.content[0]!.text, /rate limit exceeded/);
});

test("a successful call touches last_used_at with single-statement queries", async () => {
  const fp = signedIn();
  await rpc(fp, { jsonrpc: "2.0", id: 200, method: "ping" });
  // Give the fire-and-forget touch a tick to land.
  await new Promise((r) => setTimeout(r, 20));
  const touches = fp.matching("set last_used_at = now()");
  assert.equal(touches.length, 2, "grant + client are touched");
  for (const t of touches) {
    // node-postgres rejects a multi-statement string carrying bound parameters, so each touch must
    // be its own statement — otherwise it fails silently and "last used" never updates.
    assert.equal(t.sql.includes(";"), false, `multi-statement parameterized query: ${t.sql}`);
    assert.equal(t.params.length, 1);
  }
});

test("bearerFromHeader parses the RFC 6750 scheme, and does it linearly", () => {
  assert.equal(bearerFromHeader("Bearer abc"), "abc");
  assert.equal(bearerFromHeader("bearer abc"), "abc");
  assert.equal(bearerFromHeader("BEARER	abc"), "abc");
  assert.equal(bearerFromHeader("  Bearer   abc  "), "abc");
  // Not a bearer credential.
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(bearerFromHeader(""), null);
  assert.equal(bearerFromHeader("Bearer"), null);
  assert.equal(bearerFromHeader("Bearer   "), null);
  assert.equal(bearerFromHeader("bearertoken"), null, "the keyword must be followed by whitespace");
  assert.equal(bearerFromHeader("Basic abc"), null);

  // The reason it is not a regex (CodeQL js/polynomial-redos): `/^Bearer\s+(.+)$/i` backtracks on
  // a header of many spaces, and this is the most attacker-controlled string the server reads.
  const adversarial = `Bearer ${" ".repeat(200_000)}`;
  const started = process.hrtime.bigint();
  assert.equal(bearerFromHeader(adversarial), null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `bearer parse took ${ms}ms on adversarial input`);
});

test("batches are bounded", async () => {
  const fp = signedIn();
  const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
  const res = await rpc(fp, batch);
  assert.equal(res.status, 400);
});
