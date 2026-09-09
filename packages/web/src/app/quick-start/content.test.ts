// Unit tests for the Quick start content module (SKILLY_SPEC.md §23 "Quick start"). Pure data —
// no React. Guards the step order, the numbering, and the link targets of the "Two more ways to
// connect your agent" step. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUICK_START } from "./content";

const steps = QUICK_START.filter((s) => s.kind === "step");

test("quick start: numbered steps run 1..6 in order with no gaps", () => {
  assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    steps.map((s) => s.title),
    [
      "Find a skill",
      "Open a skill",
      "Install it into your agent",
      "Two more ways to connect your agent",
      "Manage what you've installed",
      "Stay in the loop",
    ],
  );
});

test("quick start: step 4 links same-tab to the Marketplaces directory and the MCP page", () => {
  const connect = steps.find((s) => s.n === 4);
  assert.ok(connect);
  assert.deepEqual(
    connect.internalLinks?.map((l) => l.href),
    ["/catalog/marketplaces", "/mcp"],
  );
  // Internal routes must never be declared as external (new-tab) links.
  assert.equal(connect.links, undefined);
  assert.equal(connect.image, "/quickstart/connect.png");
});

test("quick start: step 4 copy covers both routes, the client requirement, and the admin caveat", () => {
  const connect = steps.find((s) => s.n === 4);
  assert.ok(connect);
  const text = [connect.lead, ...(connect.points ?? [])].join("\n");
  assert.match(text, /plugin marketplace/);
  assert.match(text, /one public marketplace, plus one for each team/);
  assert.match(text, /Terminal, Claude CLI, or a Settings file/);
  assert.match(text, /My marketplaces in the account menu/);
  assert.match(text, /MCP/);
  assert.match(text, /Claude Code, Claude Desktop, and VS Code/);
  assert.match(text, /No credential goes into any config file/);
  assert.match(text, /Revoke a connection/);
  assert.match(text, /administrator decides whether these are enabled/);
});

test("quick start: the intro names all three consumption routes", () => {
  const intro = QUICK_START.find((s) => s.kind === "intro");
  assert.ok(intro);
  assert.match(intro.lead, /install it into your agent/);
  assert.match(intro.lead, /add a whole marketplace/);
  assert.match(intro.lead, /connect over MCP/);
});

test("quick start: external links are only ever http(s) and internal links only ever in-app paths", () => {
  for (const s of QUICK_START) {
    for (const l of s.links ?? []) assert.match(l.href, /^https:\/\//, `${s.title}: ${l.href}`);
    for (const l of s.internalLinks ?? []) assert.match(l.href, /^\/[a-z]/, `${s.title}: ${l.href}`);
  }
});
