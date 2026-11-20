// Unit tests for the sidebar's Administration group (SKILLY_SPEC.md §71) and the gate of the
// Namespace administration page (§75). Pure — no React, no storage. Run via
// `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_NAV_ITEMS,
  activeAdminItem,
  adminBadgeSum,
  adminNavItems,
  initialAdminOpen,
  isAdminRoute,
  namespacesPageGate,
  navBadgeText,
  parseAdminNavStored,
} from "./adminNav";

const PLATFORM = adminNavItems({ isPlatformAdmin: true, isNamespaceAdmin: false });
const NS_ADMIN = adminNavItems({ isPlatformAdmin: false, isNamespaceAdmin: true });

test("adminNavItems: a platform admin gets every item except Namespace administration, in the §71.2 order", () => {
  assert.deepEqual(
    PLATFORM.map((i) => i.label),
    ["Platform administration", "Audit log", "System log", "Monitoring", "Feature ideas", "Search gaps", "Signing"],
  );
  assert.deepEqual(
    PLATFORM.map((i) => i.href),
    ["/admin", "/audit", "/system-log", "/admin/rum", "/admin/ideas", "/admin/search-gaps", "/admin/signing"],
  );
  // §75.1 decision 3: a platform admin who also administers a namespace is a platform admin — the
  // same list, still without Namespace administration.
  assert.deepEqual(adminNavItems({ isPlatformAdmin: true, isNamespaceAdmin: true }), PLATFORM);
});

test("adminNavItems: a namespace admin gets Namespace administration and Audit log", () => {
  assert.deepEqual(NS_ADMIN.map((i) => i.label), ["Namespace administration", "Audit log"]);
  assert.deepEqual(NS_ADMIN.map((i) => i.href), ["/namespaces", "/audit"]);
});

test("adminNavItems: every item belongs to someone, and only Namespace administration is namespace-only", () => {
  const shown = new Set([...PLATFORM, ...NS_ADMIN].map((i) => i.href));
  assert.deepEqual(ADMIN_NAV_ITEMS.filter((i) => !shown.has(i.href)), []);
  assert.deepEqual(ADMIN_NAV_ITEMS.filter((i) => i.audience === "namespace").map((i) => i.href), ["/namespaces"]);
});

test("namespacesPageGate: wait for the role, redirect a platform admin, render for anyone else (§75.3)", () => {
  // Role unknown: /api/me has not answered yet.
  assert.equal(namespacesPageGate(null), "wait");
  assert.equal(namespacesPageGate(undefined), "wait");
  // A platform admin goes to Administration — also when they hold a namespace-admin role, which
  // the page never needs to know about.
  assert.equal(namespacesPageGate({ isPlatformAdmin: true }), "redirect");
  // A namespace admin, and a user with no admin role (who gets the page's own empty state).
  assert.equal(namespacesPageGate({ isPlatformAdmin: false }), "render");
  assert.equal(namespacesPageGate({}), "render");
  // /api/me failed: no role will arrive, so the page renders rather than showing a skeleton forever.
  assert.equal(namespacesPageGate(null, true), "render");
  // A truthy non-boolean is not a platform admin — only the server's `true` redirects.
  assert.equal(namespacesPageGate({ isPlatformAdmin: "yes" as unknown as boolean }), "render");
});

test("adminNavItems: anyone else gets no items (no group)", () => {
  assert.deepEqual(adminNavItems({ isPlatformAdmin: false, isNamespaceAdmin: false }), []);
});

test("adminNavItems: returns a copy, so callers can't reorder the shared list", () => {
  const items = adminNavItems({ isPlatformAdmin: true, isNamespaceAdmin: false });
  items.reverse();
  assert.equal(ADMIN_NAV_ITEMS[0]?.href, "/admin");
});

test("activeAdminItem: longest prefix wins, so /admin lights only on itself", () => {
  assert.equal(activeAdminItem("/admin", PLATFORM)?.label, "Platform administration");
  assert.equal(activeAdminItem("/admin/rum", PLATFORM)?.label, "Monitoring");
  assert.equal(activeAdminItem("/admin/ideas", PLATFORM)?.label, "Feature ideas");
  assert.equal(activeAdminItem("/admin/search-gaps", PLATFORM)?.label, "Search gaps");
  assert.equal(activeAdminItem("/namespaces", NS_ADMIN)?.label, "Namespace administration");
  assert.equal(activeAdminItem("/audit", PLATFORM)?.label, "Audit log");
  assert.equal(activeAdminItem("/system-log", PLATFORM)?.label, "System log");
});

test("activeAdminItem: paths under an item light it; look-alike prefixes don't", () => {
  assert.equal(activeAdminItem("/namespaces/marketing", NS_ADMIN)?.label, "Namespace administration");
  assert.equal(activeAdminItem("/admin/unknown-page", PLATFORM)?.label, "Platform administration");
  assert.equal(activeAdminItem("/administration", PLATFORM), null);
  assert.equal(activeAdminItem("/audits", PLATFORM), null);
  assert.equal(activeAdminItem("/", PLATFORM), null);
  assert.equal(activeAdminItem("/usage", PLATFORM), null);
  assert.equal(activeAdminItem("/catalog", PLATFORM), null);
});

test("activeAdminItem: only the viewer's own items count", () => {
  // A namespace admin who opens a platform-admin page sees its empty state; no item of theirs lights.
  assert.equal(activeAdminItem("/admin/rum", NS_ADMIN), null);
  assert.equal(activeAdminItem("/audit", NS_ADMIN)?.label, "Audit log");
  // §75: a platform admin has no Namespace administration item, so nothing lights on /namespaces
  // (they are redirected to /admin anyway).
  assert.equal(activeAdminItem("/namespaces", PLATFORM), null);
});

test("isAdminRoute: the group's routes and nothing else", () => {
  for (const p of ["/admin", "/admin/rum", "/admin/ideas", "/admin/search-gaps", "/admin/signing", "/audit", "/system-log"]) {
    assert.equal(isAdminRoute(p, PLATFORM), true, p);
  }
  for (const p of ["/", "/catalog", "/usage", "/proposals", "/leaderboard", "/profile"]) {
    assert.equal(isAdminRoute(p, PLATFORM), false, p);
  }
  assert.equal(isAdminRoute("/system-log", NS_ADMIN), false);
  // §75 / §71.4: /namespaces is a group route only for the viewer who has its item.
  assert.equal(isAdminRoute("/namespaces", NS_ADMIN), true);
  assert.equal(isAdminRoute("/namespaces", PLATFORM), false);
  assert.equal(initialAdminOpen("/namespaces", null, PLATFORM), false);
  assert.equal(initialAdminOpen("/namespaces", null, NS_ADMIN), true);
});

test("adminBadgeSum: adds the counts of the viewer's badged items", () => {
  assert.equal(adminBadgeSum({ systemLog: 3, ideas: 2, searchGaps: 4 }, PLATFORM), 9);
  assert.equal(adminBadgeSum({ systemLog: 0, ideas: 0, searchGaps: 0 }, PLATFORM), 0);
  assert.equal(adminBadgeSum({}, PLATFORM), 0);
  // Namespace admins' items carry no badges, so their header never shows one.
  assert.equal(adminBadgeSum({ systemLog: 3, ideas: 2, searchGaps: 4 }, NS_ADMIN), 0);
  // Junk from the poll never produces a negative or NaN badge.
  assert.equal(adminBadgeSum({ systemLog: -1, ideas: Number.NaN, searchGaps: 2 }, PLATFORM), 2);
});

test("navBadgeText: 1–9, then 9+", () => {
  assert.equal(navBadgeText(1), "1");
  assert.equal(navBadgeText(9), "9");
  assert.equal(navBadgeText(10), "9+");
  assert.equal(navBadgeText(adminBadgeSum({ systemLog: 8, ideas: 5 }, PLATFORM)), "9+");
});

test("parseAdminNavStored: only 'open' and 'closed' are choices", () => {
  assert.equal(parseAdminNavStored("open"), "open");
  assert.equal(parseAdminNavStored("closed"), "closed");
  assert.equal(parseAdminNavStored(null), null);
  assert.equal(parseAdminNavStored(undefined), null);
  assert.equal(parseAdminNavStored("1"), null);
  assert.equal(parseAdminNavStored(""), null);
});

test("initialAdminOpen: a group route opens it; elsewhere the stored choice; no choice = collapsed", () => {
  assert.equal(initialAdminOpen("/admin/ideas", "closed", PLATFORM), true);
  assert.equal(initialAdminOpen("/admin/ideas", null, PLATFORM), true);
  assert.equal(initialAdminOpen("/catalog", "open", PLATFORM), true);
  assert.equal(initialAdminOpen("/catalog", "closed", PLATFORM), false);
  // Unavailable storage reads as no choice.
  assert.equal(initialAdminOpen("/catalog", null, PLATFORM), false);
});
