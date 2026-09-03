// Unit tests for the Marketplaces page's pure rules (SKILLY_SPEC.md §30.6 Page 3): contact
// three-state resolution, the caller's added state, the header-search predicate, and the
// freshness label. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addedState,
  directoryMatches,
  filterDirectory,
  resolveContact,
  syncedLabel,
  type DirectorySearchFields,
} from "./marketplaceDirectoryFilter.js";

const USER = { userId: "u1", displayName: "Ada Lovelace", avatar: null };

test("resolveContact: empty or missing contact → none, regardless of a match", () => {
  assert.deepEqual(resolveContact(null, null), { kind: "none" });
  assert.deepEqual(resolveContact("", null), { kind: "none" });
  assert.deepEqual(resolveContact("   ", USER), { kind: "none" });
});

test("resolveContact: a matched active user → user state with their identity", () => {
  assert.deepEqual(resolveContact("ada@org", USER), { kind: "user", userId: "u1", displayName: "Ada Lovelace", avatar: null });
});

test("resolveContact: a contact nobody matches → email state (distribution list / leaver)", () => {
  assert.deepEqual(resolveContact("  ops-team@org ", null), { kind: "email", email: "ops-team@org" });
});

test("addedState: none without used tokens; active if any token is still valid; expired otherwise", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  assert.equal(addedState([], now), "none");
  assert.equal(addedState([{ expiresAt: null }], now), "active", "never-expiring token is live");
  assert.equal(addedState([{ expiresAt: "2026-09-04T00:00:00Z" }], now), "active");
  assert.equal(addedState([{ expiresAt: "2026-09-01T00:00:00Z" }], now), "expired");
  assert.equal(
    addedState([{ expiresAt: "2026-09-01T00:00:00Z" }, { expiresAt: "2027-01-01T00:00:00Z" }], now),
    "active",
    "one live token outweighs any number of expired ones",
  );
});

const PUBLIC: DirectorySearchFields = { scope: "public", namespaceSlug: null, displayName: "Public marketplace", name: "skilly-public", contact: { kind: "none" } };
const TEAM_A: DirectorySearchFields = { scope: "namespace", namespaceSlug: "team-a", displayName: "Team A", name: "skilly-team-a", contact: { kind: "user", ...USER } };
const OPS: DirectorySearchFields = { scope: "namespace", namespaceSlug: "ops", displayName: "Operations", name: "skilly-ops", contact: { kind: "email", email: "ops-team@org" } };
const ALL = [PUBLIC, TEAM_A, OPS];

test("filterDirectory: an empty query returns the list unchanged, by reference", () => {
  assert.equal(filterDirectory(ALL, ""), ALL);
  assert.equal(filterDirectory(ALL, "   "), ALL);
});

test("filterDirectory: matches display name, slug, marketplace name, scope word, and contact", () => {
  assert.deepEqual(filterDirectory(ALL, "team a"), [TEAM_A], "display name");
  assert.deepEqual(filterDirectory(ALL, "skilly-ops"), [OPS], "marketplace name");
  assert.deepEqual(filterDirectory(ALL, "public"), [PUBLIC], "scope word / display name");
  assert.deepEqual(filterDirectory(ALL, "lovelace"), [TEAM_A], "resolved contact's name");
  assert.deepEqual(filterDirectory(ALL, "ops-team@"), [OPS], "unresolved contact's address");
  assert.deepEqual(filterDirectory(ALL, "  TEAM-A  "), [TEAM_A], "trimmed + case-insensitive");
  assert.deepEqual(filterDirectory(ALL, "nothing-here"), []);
});

test("directoryMatches: a none-contact row never matches on contact text", () => {
  assert.equal(directoryMatches(PUBLIC, "n/a"), false);
  assert.equal(directoryMatches(PUBLIC, "none"), false);
});

test("syncedLabel: not synced yet, then coarse relative ages", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  assert.equal(syncedLabel(null, now), "not synced yet");
  assert.equal(syncedLabel("2026-09-03T11:59:30Z", now), "synced just now");
  assert.equal(syncedLabel("2026-09-03T11:47:00Z", now), "synced 13 min ago");
  assert.equal(syncedLabel("2026-09-03T09:00:00Z", now), "synced 3 h ago");
  assert.equal(syncedLabel("2026-08-30T12:00:00Z", now), "synced 4 d ago");
  assert.equal(syncedLabel("2026-09-03T12:30:00Z", now), "synced just now", "a clock-skewed future stamp never goes negative");
});
