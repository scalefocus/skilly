import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMarketplaces, marketplaceMatches, type MarketplaceSearchFields } from "./marketplaceFilter.js";

const PUBLIC: MarketplaceSearchFields = { name: "skilly-public", namespaceSlug: null, scope: "public" };
const TEAM_A: MarketplaceSearchFields = { name: "skilly-team-a", namespaceSlug: "team-a", scope: "namespace" };
const PLATFORM: MarketplaceSearchFields = { name: "skilly-platform", namespaceSlug: "platform", scope: "namespace" };
const ALL = [PUBLIC, TEAM_A, PLATFORM];

test("an empty query returns the list unchanged, by reference", () => {
  assert.equal(filterMarketplaces(ALL, ""), ALL);
  assert.equal(filterMarketplaces(ALL, "   "), ALL);
});

test("matches on name, namespace slug, and scope word", () => {
  assert.deepEqual(filterMarketplaces(ALL, "team"), [TEAM_A]);
  assert.deepEqual(filterMarketplaces(ALL, "public"), [PUBLIC]);
  // "namespace" is the scope word — it finds every namespace marketplace and not the public one
  assert.deepEqual(filterMarketplaces(ALL, "namespace"), [TEAM_A, PLATFORM]);
});

test("matching is case-insensitive and trims the query", () => {
  assert.deepEqual(filterMarketplaces(ALL, "  TEAM-A  "), [TEAM_A]);
  assert.deepEqual(filterMarketplaces(ALL, "SkIlLy-Public"), [PUBLIC]);
});

test("input order is preserved and non-matches drop out", () => {
  assert.deepEqual(filterMarketplaces(ALL, "skilly"), ALL);
  assert.deepEqual(filterMarketplaces(ALL, "nope"), []);
});

test("a null namespace slug never throws", () => {
  assert.equal(marketplaceMatches(PUBLIC, "team-a"), false);
  assert.equal(marketplaceMatches(PUBLIC, ""), true);
});
