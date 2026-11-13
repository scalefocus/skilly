// Leader-badge vocabulary (SKILLY_SPEC.md §21) — shared by the badge icons under the avatar
// (UserBubble) and the spelled-out list inside the directory hover card (DirectoryCard, §28).
// Lives in its own module so those two don't have to import each other.
export type LeaderMetric = "installs" | "skills" | "requests" | "watched" | "requested" | "followed" | "curated";
export interface LeaderBadgeInfo { metric: LeaderMetric; window: "all" | "30d" }

export const BADGE_META: Record<LeaderMetric, { icon: string; color: string; label: string }> = {
  installs: { icon: "📥", color: "var(--accent)", label: "Installs leader" },
  skills: { icon: "📝", color: "var(--accent-2)", label: "Adoption leader" },
  requests: { icon: "🎁", color: "var(--ok)", label: "Fulfillment leader" },
  watched: { icon: "👁", color: "var(--warn)", label: "Watch leader" },
  // Violet is the one hue the other four don't use, so it stays distinguishable at badge size (§21).
  requested: { icon: "💡", color: "var(--violet)", label: "Request leader" },
  // §35.7 — the one metric whose two windows carry distinct names and glyphs (see badgeIcon /
  // badgeLabel); these are the all-time values.
  followed: { icon: "📣", color: "var(--badge-follow)", label: "Influencer-in-Chief" },
  // §38.8 — Curator, in a teal none of the other six use.
  curated: { icon: "🗂", color: "var(--badge-curate)", label: "Curator" },
};

/** The diameter of one leader badge under a bubble of `bubbleSize` px: it scales with the bubble,
 *  floored so the icon stays legible on the smallest avatars. */
export function leaderBadgeSize(bubbleSize: number): number {
  return Math.max(11, Math.round(bubbleSize * 0.42));
}

/** At most `max` badges, plus how many more there are (§21 "Row layout": a leaderboard row shows 4
 *  and a `+N` marker so every row keeps one badge line). No `max` = every badge, nothing more. */
export function splitBadges<T>(badges: readonly T[], max?: number): { shown: readonly T[]; more: number } {
  if (max === undefined || badges.length <= max) return { shown: badges, more: 0 };
  return { shown: badges.slice(0, max), more: badges.length - max };
}

/** The glyph for a badge — per-window only for `followed` (📣 all time, 📈 last 30 days). */
export function badgeIcon(b: LeaderBadgeInfo): string {
  if (b.metric === "followed" && b.window === "30d") return "📈";
  return BADGE_META[b.metric].icon;
}

/** "Request leader — all time" / "… — last 30 days". The badge's aria-label, and the line the
 *  hover card prints. The installs badge spells its metric out ("most installs received"): on its
 *  own, "Installs" was read as "skills I installed" (§21 "Skills installed"). */
export function badgeLabel(b: LeaderBadgeInfo): string {
  if (b.metric === "installs") {
    return `Installs leader — most installs received, ${b.window === "all" ? "all time" : "last 30 days"}`;
  }
  if (b.metric === "followed") {
    return b.window === "all" ? "Influencer-in-Chief — most followed, all time" : "Trendsetter — most new followers, last 30 days";
  }
  if (b.metric === "curated") {
    return b.window === "all" ? "Curator — most collections, all time" : "Curator — most new collections, last 30 days";
  }
  return `${BADGE_META[b.metric].label} — ${b.window === "all" ? "all time" : "last 30 days"}`;
}
