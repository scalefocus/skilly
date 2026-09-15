// Unit: the shared achievement tile grid (SKILLY_SPEC.md §31.5) — owner vs. other rendering,
// locked hints, grouping, and the recent-first hall order. Rendered to static markup (no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACHIEVEMENTS } from "@skilly/shared/achievements";

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

test("per-badge share affordance only when a share base is given, and only on earned tiles", () => {
  const withShare = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true, shareBase: "https://x/achievements/u1" }));
  assert.equal(count(withShare, /class="ach-share"/g), 2);
  const without = renderToStaticMarkup(createElement(AchievementGrid, { earned, showLocked: true }));
  assert.equal(count(without, /class="ach-share"/g), 0);
});
