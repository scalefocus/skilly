// Unit: the shared achievement tile grid (SKILLY_SPEC.md §31.5) — owner vs. other rendering,
// locked hints, grouping, and the recent-first hall order. Rendered to static markup (no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACHIEVEMENTS, UNAVAILABLE_HINT } from "@skilly/shared/achievements";

(globalThis as { React?: typeof React }).React = React;
const { AchievementGrid } = await import("./AchievementGrid");

const earned = [
  { key: "first_watch", earnedAt: "2026-09-01T10:00:00Z" },
  { key: "first_install", earnedAt: "2026-09-10T10:00:00Z" },
];

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

test("owner view renders every badge, earned dated, locked greyed with the how-to-earn hint", () => {
  const html = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true }));
  assert.equal(count(html, /class="ach-tile/g), ACHIEVEMENTS.length);
  assert.equal(count(html, /data-earned="1"/g), 2);
  assert.equal(count(html, /ach-tile-locked/g), ACHIEVEMENTS.length - 2);
  // A locked tile shows the hint; an earned one shows the blurb + date.
  assert.match(html, /Connect an MCP client and let it make its first tool call\./);
  assert.match(html, /You brought your first skill home\./);
  assert.match(html, /Earned \d\d\/\d\d\/\d{4}/);
  // Grouped in catalog order.
  assert.ok(html.indexOf(">Consume<") < html.indexOf(">Habits<"));
});

test("other-person view renders earned tiles only; hall order is most recent first", () => {
  const html = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: false, recentFirst: true }));
  assert.equal(count(html, /class="ach-tile/g), 2);
  assert.equal(count(html, /ach-tile-locked/g), 0);
  assert.ok(html.indexOf('data-badge="first_install"') < html.indexOf('data-badge="first_watch"'));
  // No group headings in the flat hall list.
  assert.doesNotMatch(html, /ach-group-title/);
});

test("unavailable tile: a locked switch-gated badge says so instead of its hint (§31.12.4)", () => {
  const html = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true, unavailable: ["first_mcp", "first_hype"] }));
  assert.equal(count(html, /data-unavailable="1"/g), 2);
  // (Static markup escapes the hint's apostrophe, so match on its opening words.)
  assert.ok(UNAVAILABLE_HINT.startsWith("Not available here yet — your administrator decides"));
  assert.equal(count(html, /Not available here yet — your administrator decides/g), 2);
  // The MCP badge's usual hint is gone; an available locked badge keeps its own.
  assert.doesNotMatch(html, /Connect an MCP client and let it make its first tool call\./);
  assert.match(html, /Watch a skill to be told about new versions\.|Rate a skill on its page\./);
  // An earned key is never marked, even if listed.
  const earnedListed = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true, unavailable: ["first_install"] }));
  assert.equal(count(earnedListed, /data-unavailable="1"/g), 0);
  // Without the list nothing is marked.
  const plain = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true }));
  assert.equal(count(plain, /data-unavailable="1"/g), 0);
});

test("AI copy: Robot Sidekick's hint names the AI by its display name, never the raw token (§31.12.5)", () => {
  const html = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true }));
  // Static markup renders with the default display name ("AI") — the /api/me fetch never runs here.
  assert.match(html, /Use Draft with AI on the propose form, or Draft improvements with AI on a skill you maintain\./);
  assert.doesNotMatch(html, /\{name\}/);
});

test("per-badge share affordance only when a share base is given, and only on earned tiles", () => {
  const withShare = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true, shareBase: "https://x/achievements/u1" }));
  assert.equal(count(withShare, /class="ach-share"/g), 2);
  const without = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true }));
  assert.equal(count(without, /class="ach-share"/g), 0);
});
