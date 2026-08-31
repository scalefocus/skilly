import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_TOOL_NAMES,
  MCP_TOOL_CEILING,
  MCP_WRITE_TOOLS,
  buildSkillResourceUri,
  parseSkillResourceUri,
  isSafeBundlePath,
  resourceTemplates,
  decodeInlineBundle,
  isJsonRpcRequest,
  rpcResult,
  rpcError,
  toolError,
  toolJson,
} from "./mcp.js";

test("the tool inventory is exactly the §29 ceiling, with unique names", () => {
  assert.equal(MCP_TOOL_NAMES.length, MCP_TOOL_CEILING);
  assert.equal(new Set(MCP_TOOL_NAMES).size, MCP_TOOL_CEILING);
});

test("the excluded surface has no tool (§29): no review decisions, no admin, no destruction", () => {
  const forbidden = [
    "accept_proposal", "reject_proposal", "request_changes", "delete_proposal",
    "delete_skill", "yank_skill", "archive_skill", "promote_skill", "feature_skill",
    "mark_official", "erase_user", "trim_audit", "read_audit", "read_system_log",
    "update_settings", "create_namespace", "send_direct_message",
  ];
  for (const name of forbidden) {
    assert.equal(MCP_TOOL_NAMES.includes(name as never), false, `${name} must not exist as a tool`);
  }
});

test("every write tool is a real tool, and the read tools are not marked as writes", () => {
  for (const w of MCP_WRITE_TOOLS) {
    assert.equal(MCP_TOOL_NAMES.includes(w as never), true, `${w} is not in the inventory`);
  }
  for (const r of ["search_skills", "get_skill", "get_skill_content", "list_skill_files", "get_skill_file", "get_registry_metadata"]) {
    assert.equal(MCP_WRITE_TOOLS.has(r), false, `${r} must not be a write`);
  }
});

test("resource URIs round-trip in all three forms", () => {
  const latest = buildSkillResourceUri("global", "pdf-tools");
  assert.equal(latest, "skilly://skill/global/pdf-tools");
  assert.deepEqual(parseSkillResourceUri(latest), { namespaceSlug: "global", skillSlug: "pdf-tools", semver: null, path: null });

  const pinned = buildSkillResourceUri("global", "pdf-tools", "1.2.0");
  assert.equal(pinned, "skilly://skill/global/pdf-tools@1.2.0");
  assert.deepEqual(parseSkillResourceUri(pinned), { namespaceSlug: "global", skillSlug: "pdf-tools", semver: "1.2.0", path: null });

  const file = buildSkillResourceUri("acme", "deploy", "2.0.0-beta.1", "scripts/run.sh");
  assert.equal(file, "skilly://skill/acme/deploy@2.0.0-beta.1/scripts/run.sh");
  assert.deepEqual(parseSkillResourceUri(file), { namespaceSlug: "acme", skillSlug: "deploy", semver: "2.0.0-beta.1", path: "scripts/run.sh" });

  // `latest` as an explicit ref for the file form resolves to "latest stable" (semver null).
  const latestFile = buildSkillResourceUri("acme", "deploy", null, "refs/notes.md");
  assert.equal(latestFile, "skilly://skill/acme/deploy@latest/refs/notes.md");
  assert.deepEqual(parseSkillResourceUri(latestFile), { namespaceSlug: "acme", skillSlug: "deploy", semver: null, path: "refs/notes.md" });
});

test("resource URI parsing refuses traversal, junk schemes and malformed slugs", () => {
  assert.equal(parseSkillResourceUri("skilly://skill/acme/deploy@1.0.0/../../etc/passwd"), null);
  assert.equal(parseSkillResourceUri("skilly://skill/acme/deploy@1.0.0//x"), null);
  assert.equal(parseSkillResourceUri("skilly://skill/acme/deploy@1.0.0/"), null);
  assert.equal(parseSkillResourceUri("skilly://skill/acme"), null);
  assert.equal(parseSkillResourceUri("skilly://other/acme/deploy"), null);
  assert.equal(parseSkillResourceUri("https://skilly.example.com/acme/deploy"), null);
  assert.equal(parseSkillResourceUri("skilly://skill/ACME/deploy"), null);
  assert.equal(parseSkillResourceUri("skilly://skill/acme/deploy@"), null);
  assert.equal(parseSkillResourceUri("skilly://skill/acme/dep loy"), null);
  assert.equal(parseSkillResourceUri(""), null);
  assert.equal(parseSkillResourceUri(undefined as unknown as string), null);
});

test("bundle path safety", () => {
  assert.equal(isSafeBundlePath("SKILL.md"), true);
  assert.equal(isSafeBundlePath("scripts/a/b.sh"), true);
  assert.equal(isSafeBundlePath("/etc/passwd"), false);
  assert.equal(isSafeBundlePath("a/../b"), false);
  assert.equal(isSafeBundlePath("a/./b"), false);
  assert.equal(isSafeBundlePath("a//b"), false);
  assert.equal(isSafeBundlePath("a\\b"), false);
  assert.equal(isSafeBundlePath("a\0b"), false);
  assert.equal(isSafeBundlePath(""), false);
  assert.equal(isSafeBundlePath("x".repeat(513)), false);
});

test("resources/list advertises templates only — never a concrete skill URI", () => {
  const t = resourceTemplates();
  assert.equal(t.length, 3);
  for (const entry of t) {
    assert.match(entry.uriTemplate, /\{namespace\}/);
    assert.ok(entry.description.length > 0);
  }
});

test("inline bundle decode enforces the cap loudly and points at the browser", () => {
  const small = Buffer.from("hello world").toString("base64");
  const ok = decodeInlineBundle(small, 1024);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.bytes.toString(), "hello world");

  const big = Buffer.alloc(4096, 7).toString("base64");
  const capped = decodeInlineBundle(big, 1024);
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.match(capped.error, /browser/);

  assert.equal(decodeInlineBundle("", 1024).ok, false);
  assert.equal(decodeInlineBundle("not base64 !!!", 1024).ok, false);
  assert.equal(decodeInlineBundle(undefined, 1024).ok, false);
  assert.equal(decodeInlineBundle(Buffer.alloc(0).toString("base64"), 1024).ok, false);
});

test("JSON-RPC helpers", () => {
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0", method: "tools/list" }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: "1.0", method: "x" }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: "2.0" }), false);
  assert.equal(isJsonRpcRequest(null), false);

  assert.deepEqual(rpcResult(1, { a: 1 }), { jsonrpc: "2.0", id: 1, result: { a: 1 } });
  assert.deepEqual(rpcError(2, -32601, "nope"), { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "nope" } });

  const err = toolError("403");
  assert.equal(err.isError, true);
  const okr = toolJson({ x: 1 }) as { structuredContent: unknown };
  assert.deepEqual(okr.structuredContent, { x: 1 });
});
