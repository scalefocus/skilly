// Leader-badge vocabulary (SKILLY_SPEC.md §21) — shared by the badge icons under the avatar
// (UserBubble) and the spelled-out list inside the directory hover card (DirectoryCard, §28).
// Lives in its own module so those two don't have to import each other.
export type LeaderMetric = "installs" | "skills" | "requests" | "watched";
export interface LeaderBadgeInfo { metric: LeaderMetric; window: "all" | "30d" }

export const BADGE_META: Record<LeaderMetric, { icon: string; color: string; label: string }> = {
  installs: { icon: "📥", color: "var(--accent)", label: "Installs leader" },
  skills: { icon: "📝", color: "var(--accent-2)", label: "Adoption leader" },
  requests: { icon: "🎁", color: "var(--ok)", label: "Fulfillment leader" },
  watched: { icon: "👁", color: "var(--warn)", label: "Watch leader" },
};

/** "Installs leader — all time" / "… — last 30 days". The badge's aria-label, and the line the
 *  hover card prints. */
export function badgeLabel(b: LeaderBadgeInfo): string {
  return `${BADGE_META[b.metric].label} — ${b.window === "all" ? "all time" : "last 30 days"}`;
}
