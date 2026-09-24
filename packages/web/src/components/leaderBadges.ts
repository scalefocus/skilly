// Leader-badge vocabulary (SKILLY_SPEC.md §21) — shared by the badge icons under the avatar
// (UserBubble) and the spelled-out list inside the directory hover card (DirectoryCard, §28).
// Lives in its own module so those two don't have to import each other.
export type LeaderMetric = "installs" | "skills" | "requests" | "watched" | "requested" | "followed";
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
};

/** The glyph for a badge — per-window only for `followed` (📣 all time, 📈 last 30 days). */
export function badgeIcon(b: LeaderBadgeInfo): string {
  if (b.metric === "followed" && b.window === "30d") return "📈";
  return BADGE_META[b.metric].icon;
}

/** "Installs leader — all time" / "… — last 30 days". The badge's aria-label, and the line the
 *  hover card prints. */
export function badgeLabel(b: LeaderBadgeInfo): string {
  if (b.metric === "followed") {
    return b.window === "all" ? "Influencer-in-Chief — most followed, all time" : "Trendsetter — most new followers, last 30 days";
  }
  return `${BADGE_META[b.metric].label} — ${b.window === "all" ? "all time" : "last 30 days"}`;
}
