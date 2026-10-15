// Per-skill grouping for the Installed Skills page (SKILLY_SPEC.md §23 "One card per skill"). A
// skill with one visible install is a plain row; two or more become one collapsible card. Grouping is
// client-side over the already-loaded (and already filtered) rows — the API is unchanged. Pure
// functions, so the ordering and the card summary are unit-testable.
import { compareSemver } from "@skilly/shared/semver";
import type { Freshness } from "@skilly/shared/freshness";
import { installRef, sortInstalls, type InstalledSort } from "./installedFilter";

/** The fields grouping and the card summary read off an installed row. */
export interface GroupableInstall {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  installedAt: string;
  pinnedSemver: string | null;
  freshness: Freshness;
  inactive: boolean;
}

/** One list entry: a plain row (one visible install) or a card (two or more). */
export type InstallEntry<T> =
  | { kind: "row"; ref: string; install: T }
  | {
      kind: "card";
      ref: string;
      /** The visible installs, newest first. */
      installs: T[];
      /** All loaded installs of the skill, before the search / Behind-latest filters ("2 of 3"). */
      total: number;
    };

const newest = (a: { installedAt: string }, b: { installedAt: string }) => (Date.parse(b.installedAt) || 0) - (Date.parse(a.installedAt) || 0);

/**
 * Group the visible rows by skill (`@ns/slug`). Filter FIRST, then group (§23): a skill left with one
 * matching install is a plain row. Entries follow the page sort — under A–Z an entry ranks by its
 * title (ties: its newest install); under Recently installed a card ranks by its newest install —
 * which is exactly the first appearance of each skill in the sorted rows. Children: newest first.
 */
export function groupInstalls<T extends GroupableInstall>(visible: T[], all: T[], sort: InstalledSort): InstallEntry<T>[] {
  const totals = new Map<string, number>();
  for (const i of all) totals.set(installRef(i), (totals.get(installRef(i)) ?? 0) + 1);
  const bySkill = new Map<string, T[]>();
  for (const i of sortInstalls(visible, sort)) {
    const ref = installRef(i);
    const list = bySkill.get(ref);
    if (list) list.push(i);
    else bySkill.set(ref, [i]);
  }
  return [...bySkill].map(([ref, installs]) =>
    installs.length === 1
      ? { kind: "row", ref, install: installs[0]! }
      : { kind: "card", ref, installs: [...installs].sort(newest), total: Math.max(totals.get(ref) ?? 0, installs.length) },
  );
}

/** "3 installations", or "2 of 3 installations" when a filter hides some. */
export function cardCountLabel(shown: number, total: number): string {
  return shown < total ? `${shown} of ${total} installations` : `${shown} installations`;
}

/** The de-duplicated version modes of a card: "latest" first, then pinned versions highest → lowest. */
export function versionModes(installs: Array<{ pinnedSemver: string | null }>): string[] {
  const pins = [...new Set(installs.map((i) => i.pinnedSemver).filter((v): v is string => v !== null))];
  pins.sort((a, b) => compareSemver(b, a));
  return [...(installs.some((i) => i.pinnedSemver === null) ? ["latest"] : []), ...pins.map((v) => `pinned v${v}`)];
}

/** The card's badge: Withdrawn if any install is withdrawn, else Behind if any is behind, else none. */
export function worstFreshness(installs: Array<{ freshness: Freshness }>): "withdrawn" | "behind" | null {
  if (installs.some((i) => i.freshness === "withdrawn")) return "withdrawn";
  if (installs.some((i) => i.freshness === "behind")) return "behind";
  return null;
}

/** Active / inactive counts for the header pills (a zero count is simply not shown). */
export function activeCounts(installs: Array<{ inactive: boolean }>): { active: number; inactive: number } {
  const inactive = installs.filter((i) => i.inactive).length;
  return { active: installs.length - inactive, inactive };
}

/** The newest install's date (ISO) — "last installed ‹date›". */
export function lastInstalledAt(installs: Array<{ installedAt: string }>): string | null {
  return [...installs].sort(newest)[0]?.installedAt ?? null;
}
