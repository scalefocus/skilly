// Unit tests for the /mcp-server Connect snippets (SKILLY_SPEC.md §29 "The /mcp-server page").
// Pins each client's exact format, so a wrong key can't slip back in (the page once shipped a
// "Claude Desktop / VS Code" block in a shape neither client reads). Run via
// `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectSnippets,
  connectorEligible,
  DEFAULT_MCP_SCOPE,
  hintText,
  MCP_SCOPE_KEY,
  parseMcpScope,
} from "./snippets";

const URL_ = "https://skilly.example.com/mcp";

test("parseMcpScope: keeps user/local; anything else (incl. nothing stored) is Every project", () => {
  assert.equal(parseMcpScope("user"), "user");
  assert.equal(parseMcpScope("local"), "local");
  assert.equal(parseMcpScope(null), "user");
  assert.equal(parseMcpScope(undefined), "user");
  assert.equal(parseMcpScope("project"), "user");
  assert.equal(parseMcpScope("LOCAL"), "user");
  assert.equal(DEFAULT_MCP_SCOPE, "user");
  assert.equal(MCP_SCOPE_KEY, "skilly.mcpScope");
});

test("Claude Code: the toggle sets --scope, spelled out in both cases", () => {
  assert.equal(
    connectSnippets(URL_, "user").claudeCode.command,
    "claude mcp add --transport http --scope user skilly https://skilly.example.com/mcp",
  );
  assert.equal(
    connectSnippets(URL_, "local").claudeCode.command,
    "claude mcp add --transport http --scope local skilly https://skilly.example.com/mcp",
  );
});

test("Claude Code: only This project tells you where to run it; both say how to sign in", () => {
  const user = connectSnippets(URL_, "user").claudeCode;
  const local = connectSnippets(URL_, "local").claudeCode;
  assert.equal(user.hint, null);
  assert.equal(hintText(local.hint!), "Run it inside the project folder.");
  for (const c of [user, local]) {
    assert.equal(hintText(c.after), "Then run /mcp in Claude Code, choose skilly and sign in in the browser.");
  }
});

test("VS Code: top-level `servers` with type http — never `mcpServers`", () => {
  for (const scope of ["user", "local"] as const) {
    const parsed = JSON.parse(connectSnippets(URL_, scope).vscode.json);
    assert.deepEqual(parsed, { servers: { skilly: { type: "http", url: URL_ } } });
    assert.equal("mcpServers" in parsed, false);
  }
});

test("Cursor: top-level `mcpServers` with url only — no `type`", () => {
  for (const scope of ["user", "local"] as const) {
    const parsed = JSON.parse(connectSnippets(URL_, scope).cursor.json);
    assert.deepEqual(parsed, { mcpServers: { skilly: { url: URL_ } } });
    assert.equal("type" in parsed.mcpServers.skilly, false);
  }
});

test("VS Code and Cursor: the JSON is identical across scopes; only the hint changes", () => {
  const user = connectSnippets(URL_, "user");
  const local = connectSnippets(URL_, "local");
  assert.equal(user.vscode.json, local.vscode.json);
  assert.equal(user.cursor.json, local.cursor.json);
  assert.equal(
    hintText(user.vscode.hint),
    "Run MCP: Open User Configuration from the Command Palette and add the skilly entry.",
  );
  assert.equal(
    hintText(local.vscode.hint),
    "Save as .vscode/mcp.json in the workspace, or add the skilly entry to the existing file.",
  );
  assert.equal(hintText(user.cursor.hint), "Save as ~/.cursor/mcp.json, or add the skilly entry to the existing file.");
  assert.equal(
    hintText(local.cursor.hint),
    "Save as .cursor/mcp.json in the project, or add the skilly entry to the existing file.",
  );
});

test("JSON snippets are pretty-printed with a 2-space indent", () => {
  const { vscode, cursor } = connectSnippets(URL_, "user");
  assert.match(vscode.json, /^\{\n {2}"servers": \{\n {4}"skilly": \{/);
  assert.match(cursor.json, /^\{\n {2}"mcpServers": \{\n {4}"skilly": \{/);
});

test("connectorEligible: HTTPS on port 443 only", () => {
  assert.equal(connectorEligible("https://h/mcp"), true);
  assert.equal(connectorEligible("https://h:443/mcp"), true);
  assert.equal(connectorEligible("http://h/mcp"), false);
  assert.equal(connectorEligible("https://h:8443/mcp"), false);
  assert.equal(connectorEligible("http://localhost:3000/mcp"), false);
  assert.equal(connectorEligible(""), false);
  assert.equal(connectorEligible("not a url"), false);
});
