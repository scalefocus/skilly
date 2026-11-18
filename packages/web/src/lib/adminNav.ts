// The sidebar's Administration group (SKILLY_SPEC.md §71): which admin pages a viewer sees, in what
// order, which one is active, the collapsed header's badge sum, and the group's starting state.
// Pure — no React, no storage, no fetch — so the client shell and the unit tests share it.

/** The badge counts the shell polls from GET /api/nav-badges that belong to group items. */
export type AdminBadgeKey = "systemLog" | "ideas" | "searchGaps";

export type AdminNavItem = {
  href: string;
  label: string;
  /** SVG path for the 24×24 nav glyph. */
  icon: string;
  /** "platform" = platform admins only; "admin" = platform admins and namespace admins. */
  audience: "platform" | "admin";
  badge?: { key: AdminBadgeKey; label: string };
};

/** The header's glyph: the shield the flat /admin link used before the group (§71.2). */
export const ADMIN_GROUP_ICON = "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z";

/** localStorage key for the viewer's open/closed choice — this browser only (§71.4). */
export const ADMIN_NAV_STORAGE_KEY = "skilly-nav-admin";

/** Top to bottom (§71.2). Each item's audience is unchanged from the flat links it replaces. */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  // Sidebar-only label: the page's eyebrow. Presence and RUM keep "Administration" (§71.7).
  { href: "/admin", label: "Platform administration", audience: "platform", icon: "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" },
  { href: "/namespaces", label: "Namespace administration", audience: "admin", icon: "M3 7h18M3 12h18M3 17h18M7 4v16" },
  { href: "/audit", label: "Audit log", audience: "admin", icon: "M5 4h11l3 3v13H5zM8 11h8M8 15h5M8 7h4" },
  { href: "/system-log", label: "System log", audience: "platform", icon: "M4 5h16v14H4zM7 9h2M7 13h2M7 17h2M12 9h5M12 13h5", badge: { key: "systemLog", label: "new" } },
  // §32.7 the sidebar label only; the page title stays "Real user monitoring."
  { href: "/admin/rum", label: "Monitoring", audience: "platform", icon: "M3 17l5-6 4 4 5-8 4 5M3 21h18" },
  { href: "/admin/ideas", label: "Feature ideas", audience: "platform", icon: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z", badge: { key: "ideas", label: "pending" } },
  { href: "/admin/search-gaps", label: "Search gaps", audience: "platform", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6", badge: { key: "searchGaps", label: "to review" } },
  // §73.8 signing keys, revocation and mismatch reports.
  { href: "/admin/signing", label: "Signing", audience: "platform", icon: "M7 15a4 4 0 1 1 3.87-5H21v3h-2v3h-3v-3h-5.13A4 4 0 0 1 7 15zM7 11h.01" },
];

/**
 * The items this viewer sees: all of them for a platform admin, the shared-audience items for a
 * namespace admin, none for anyone else (then the group is not drawn at all).
 */
export function adminNavItems(viewer: { isPlatformAdmin: boolean; isNamespaceAdmin: boolean }): AdminNavItem[] {
  if (viewer.isPlatformAdmin) return [...ADMIN_NAV_ITEMS];
  if (viewer.isNamespaceAdmin) return ADMIN_NAV_ITEMS.filter((i) => i.audience === "admin");
  return [];
}

/** `pathname` is `href` itself or a path under it — a whole-segment match, so /admins ≠ /admin. */
function under(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The item for the current page: the longest matching href, so /admin/rum lights Monitoring only. */
export function activeAdminItem(pathname: string, items: readonly AdminNavItem[]): AdminNavItem | null {
  let best: AdminNavItem | null = null;
  for (const item of items) {
    if (under(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}

/** Whether the page belongs to the viewer's group — landing on one opens it (§71.4). */
export function isAdminRoute(pathname: string, items: readonly AdminNavItem[]): boolean {
  return activeAdminItem(pathname, items) !== null;
}

/** The collapsed header's badge: the sum of the counts the viewer's items would show (§71.5). */
export function adminBadgeSum(counts: Partial<Record<AdminBadgeKey, number>>, items: readonly AdminNavItem[]): number {
  let sum = 0;
  for (const item of items) {
    if (!item.badge) continue;
    const n = Number(counts[item.badge.key] ?? 0);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return sum;
}

/** The superscript text every nav badge uses: 1–9, then 9+. */
export function navBadgeText(n: number): string {
  return n > 9 ? "9+" : String(n);
}

export type AdminNavStored = "open" | "closed" | null;

/** A raw localStorage value as a stored choice; anything unrecognised counts as no choice. */
export function parseAdminNavStored(raw: string | null | undefined): AdminNavStored {
  return raw === "open" || raw === "closed" ? raw : null;
}

/**
 * The group's state when it first appears: open on one of its own pages, otherwise the stored
 * choice, otherwise collapsed (also what unavailable storage gives, since it reads as null).
 */
export function initialAdminOpen(pathname: string, stored: AdminNavStored, items: readonly AdminNavItem[]): boolean {
  return isAdminRoute(pathname, items) || stored === "open";
}
