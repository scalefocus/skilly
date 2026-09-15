// Unit tests for the Quick start content module (SKILLY_SPEC.md §23 "Quick start"). Pure data —
// no React. Guards the step order, the numbering, and the link targets of the "Two more ways to
// connect your agent" step. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACHIEVEMENTS } from "@skilly/shared/achievements";
import { QUICK_START } from "./content";

const steps = QUICK_START.filter((s) => s.kind === "step");
const textOf = (s: (typeof QUICK_START)[number]) => [s.lead, ...(s.points ?? [])].join("\n");

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
  const text = textOf(connect);
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

// v2.0.0 replaced per-skill plugins with one plugin per category and renamed skill invocation.
// Step 4 predates that change, so this guards the corrected copy against silently reverting.
test("quick start: step 4 explains that a marketplace ships category plugins, not single skills", () => {
  const connect = steps.find((s) => s.n === 4);
  assert.ok(connect);
  const text = textOf(connect);
  assert.match(text, /one plugin per category/);
  assert.match(text, /general plugin/);
  assert.match(text, /\/<category>:<skill>/);
  assert.match(text, /\/<category>:<namespace>-<skill>/);
});

// ---------------------------------------------------------------------------------------------
// The Achievements card (§23 / §31.5) — unnumbered, conditional, and quoting the shared catalog.
// ---------------------------------------------------------------------------------------------

const achievements = QUICK_START.find((s) => s.kind === "achievements");

/** The badge names the card quotes verbatim. Both directions are asserted below. */
const QUOTED_BADGES = ["Read the Manual", "Hello, Skill", "Bulk Buyer", "Ghost in the Machine", "Wishful Thinker", "Homegrown"];

test("quick start: the achievements card sits after the last step and before the contribute card", () => {
  assert.ok(achievements, "the achievements card is missing");
  const kinds = QUICK_START.map((s) => s.kind);
  const lastStep = kinds.lastIndexOf("step");
  const idx = kinds.indexOf("achievements");
  const contribute = kinds.indexOf("contribute");
  assert.equal(idx, lastStep + 1, "achievements must directly follow the last numbered step");
  assert.equal(contribute, idx + 1, "the contribute card must directly follow achievements");
  // Unnumbered: it must never join the consumer spine.
  assert.equal(achievements.n, undefined);
  assert.equal(kinds.filter((k) => k === "achievements").length, 1);
});

test("quick start: the achievements card links same-tab to the profile card, not the hall", () => {
  assert.ok(achievements);
  assert.deepEqual(achievements.internalLinks?.map((l) => l.href), ["/profile#achievements"]);
  assert.equal(achievements.links, undefined);
  assert.equal(achievements.image, "/quickstart/achievements.png");
});

// The card duplicates badge names in hand-authored prose rather than rendering the catalog, so a
// rename in @skilly/shared must fail the build instead of silently falsifying onboarding copy.
test("quick start: every badge name the achievements card quotes still exists in the catalog", () => {
  assert.ok(achievements);
  const text = textOf(achievements);
  const names = new Set(ACHIEVEMENTS.map((a) => a.name));
  for (const q of QUOTED_BADGES) {
    assert.ok(names.has(q), `the copy quotes "${q}", which is no longer a badge name in @skilly/shared/achievements`);
    assert.ok(text.includes(q), `"${q}" is listed as quoted but no longer appears in the card copy`);
  }
});

// A deliberate, spec'd exclusion: an onboarding tour on an employer-hosted registry does not
// advertise working at midnight or at the weekend. They stay discoverable on the profile card.
test("quick start: the achievements card never names the habits badges", () => {
  assert.ok(achievements);
  const text = textOf(achievements);
  for (const key of ["night_shift", "weekend_warrior"]) {
    const def = ACHIEVEMENTS.find((a) => a.key === key);
    assert.ok(def, `${key} is missing from the catalog`);
    assert.ok(!text.includes(def.name), `the card must not name the habits badge "${def.name}"`);
  }
});

test("quick start: the achievements card covers sharing, the privacy switch, and the leaderboard distinction", () => {
  assert.ok(achievements);
  const text = textOf(achievements);
  // Tenseless: true on a first read and on a re-read months later.
  assert.match(text, /Completing this Quick start earns/);
  assert.doesNotMatch(text, /you just earned/i);
  assert.match(text, /hall that any signed-in colleague can open/);
  assert.match(text, /switch on your Profile/);
  assert.match(text, /personal and permanent/);
  assert.match(text, /competitive leaderboard/);
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
