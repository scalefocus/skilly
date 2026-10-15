// Unit tests for the Installed page's per-skill cards (SKILLY_SPEC.md §23 "One card per skill").
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Freshness } from "@skilly/shared/freshness";
import { activeCounts, cardCountLabel, groupInstalls, lastInstalledAt, versionModes, worstFreshness, type InstallEntry } from "./installedGroups";
import { filterBehind } from "./installedFilter";

let n = 0;
const mk = (ns: string, slug: string, title: string, installedAt: string, opts: { pinned?: string; freshness?: Freshness; inactive?: boolean } = {}) => ({
  id: `i${++n}`,
  namespaceSlug: ns,
  skillSlug: slug,
  title,
  installedAt,
  pinnedSemver: opts.pinned ?? null,
  freshness: opts.freshness ?? "current",
  inactive: opts.inactive ?? false,
});

const web1 = mk("global", "web-scraper", "Web Scraper", "2026-10-01T10:00:00Z", { pinned: "1.0.0", freshness: "behind" });
const web2 = mk("global", "web-scraper", "Web Scraper", "2026-10-14T10:00:00Z");
const web3 = mk("global", "web-scraper", "Web Scraper", "2026-10-05T10:00:00Z", { pinned: "1.2.0", inactive: true });
const lint = mk("global", "lint-fixer", "Lint Fixer", "2026-10-10T10:00:00Z", { freshness: "behind" });
const pdf = mk("global", "pdf-tools", "PDF Tools", "2026-10-12T10:00:00Z");
const all = [pdf, web1, lint, web2, web3];

const shape = (entries: InstallEntry<(typeof all)[number]>[]) =>
  entries.map((e) => (e.kind === "row" ? `row:${e.ref}` : `card:${e.ref}:${e.installs.map((i) => i.id).join(",")}:${e.total}`));

test("a skill with one install is a plain row; two or more become one card, children newest first", () => {
  assert.deepEqual(shape(groupInstalls(all, all, "alpha")), [
    "row:global/lint-fixer",
    "row:global/pdf-tools",
    `card:global/web-scraper:${web2.id},${web3.id},${web1.id}:3`,
  ]);
});

test("Recently installed ranks a card by its NEWEST install", () => {
  // web-scraper's newest (Oct 14) beats pdf (Oct 12) and lint (Oct 10), though its oldest is Oct 1.
  assert.deepEqual(shape(groupInstalls(all, all, "recent")).map((s) => s.split(":").slice(0, 2).join(":")), [
    "card:global/web-scraper",
    "row:global/pdf-tools",
    "row:global/lint-fixer",
  ]);
});

test("same title in two namespaces stays two entries (grouping is by @ns/slug, not title)", () => {
  const a = mk("global", "pdf-tools", "PDF Tools", "2026-10-01T00:00:00Z");
  const b = mk("team-a", "pdf-tools", "PDF Tools", "2026-10-02T00:00:00Z");
  assert.deepEqual(shape(groupInstalls([a, b], [a, b], "alpha")), ["row:team-a/pdf-tools", "row:global/pdf-tools"]);
});

test("filter first, then group: a card shows 'N of M', and one survivor is a plain row", () => {
  const behind = filterBehind(all, true); // web1 + lint
  assert.deepEqual(shape(groupInstalls(behind, all, "alpha")), ["row:global/lint-fixer", "row:global/web-scraper"]);
  const web4 = mk("global", "web-scraper", "Web Scraper", "2026-10-15T10:00:00Z", { freshness: "withdrawn" });
  const all2 = [...all, web4];
  const entries = groupInstalls(filterBehind(all2, true), all2, "alpha");
  const card = entries.find((e) => e.kind === "card");
  assert.ok(card && card.kind === "card");
  assert.deepEqual(card.installs.map((i) => i.id), [web4.id, web1.id]);
  assert.equal(card.total, 4);
  assert.equal(cardCountLabel(card.installs.length, card.total), "2 of 4 installations");
  assert.equal(cardCountLabel(3, 3), "3 installations");
});

test("versionModes: de-duplicated, latest first, then pinned highest → lowest", () => {
  const dupPin = mk("global", "web-scraper", "Web Scraper", "2026-10-02T00:00:00Z", { pinned: "1.0.0" });
  const pre = mk("global", "web-scraper", "Web Scraper", "2026-10-03T00:00:00Z", { pinned: "1.10.0-beta.1" });
  assert.deepEqual(versionModes([web1, web2, web3, dupPin, pre]), ["latest", "pinned v1.10.0-beta.1", "pinned v1.2.0", "pinned v1.0.0"]);
  assert.deepEqual(versionModes([web1, web3]), ["pinned v1.2.0", "pinned v1.0.0"]);
});

test("worstFreshness: withdrawn beats behind; current/unknown carry no badge", () => {
  assert.equal(worstFreshness([web2, web1]), "behind");
  assert.equal(worstFreshness([web1, { freshness: "withdrawn" as Freshness }]), "withdrawn");
  assert.equal(worstFreshness([web2, { freshness: "unknown" as Freshness }]), null);
});

test("activeCounts and lastInstalledAt summarise the card", () => {
  assert.deepEqual(activeCounts([web1, web2, web3]), { active: 2, inactive: 1 });
  assert.equal(lastInstalledAt([web1, web2, web3]), web2.installedAt);
  assert.equal(lastInstalledAt([]), null);
});
