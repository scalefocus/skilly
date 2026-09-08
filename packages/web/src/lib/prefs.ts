"use client";
// Small localStorage-backed UI preferences that persist across reloads and visits (e.g. the
// remembered 7d/30d/90d/All chart window). SSR-safe: every accessor no-ops to the fallback when
// `window` is absent. Read these only inside client components AFTER the data that gates the
// control has loaded (these pages render a skeleton during SSR/first paint), so a differing
// stored value never causes a hydration mismatch.

export function readPref(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback; // private mode / storage disabled
  }
}

export function writePref(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — ignore, the choice just won't persist */
  }
}

// Stable keys for the remembered chart windows (SKILLY_SPEC.md §21).
//  - PLATFORM_RANGE: the Usage dashboard platform/namespace totals window.
//  - SKILL_RANGE: the per-skill chart window — shared by the Usage per-skill breakdown AND the
//    skill-detail installs/views chart, so the last pick is the default for every skill opened.
export const PREF_PLATFORM_RANGE = "skilly.chart.platform-range";
export const PREF_SKILL_RANGE = "skilly.chart.skill-range";
// Administration → Currently online: the daily-active-users trend chart window (§4).
export const PREF_DAU_RANGE = "skilly.chart.dau-range";
// Administration → Currently online: the selected "online" activity window in minutes (§4).
export const PREF_ONLINE_WINDOW = "skilly.online-window";
// Administration → every card is collapsible (§5). Each card remembers its own open/closed state
// under `skilly.admin.card.<id>-open`; "1" = open, anything else (including unset) = collapsed,
// the default. (The legacy single-card `skilly.admin.ns-open` and `skilly.admin.email-open` keys
// are retired — no migration.)
export const adminCardPrefKey = (id: string): string => `skilly.admin.card.${id}-open`;

export function removePref(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* private mode — nothing to remove */
  }
}

// Last-watched card (§5 Administration, §30.6 Namespace administration): the card the admin was
// last working in, remembered per browser with no expiry and auto-scrolled/flashed on the next
// visit. One key per page; the value is the card's stable id (a `cardId` on /admin, a namespace
// `id` on /namespaces). Set/clear/arrival rules: lib/lastWatched.ts.
export const PREF_ADMIN_LAST_CARD = "skilly.admin.last-card";
export const PREF_NS_LAST_CARD = "skilly.namespaces.last-card";

// The marketplace add-command panel's remembered route tab (§30.4 / §30.6): `terminal` | `cli` |
// `settings`. One key shared by the Marketplaces directory and Namespace administration — a
// consumer has a preferred tooling and should not re-pick it per row or per page. Unknown or
// missing ⇒ Terminal.
export const PREF_MARKETPLACE_ADD_ROUTE = "skilly.marketplace.add-route";
