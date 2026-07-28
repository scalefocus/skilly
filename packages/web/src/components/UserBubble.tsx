"use client";
// Profile bubble: an Entra photo (captured at the user's own sign-in, stored as a data URI) or
// initials when absent. Shared by every place a user's avatar appears — the skill-detail
// Maintainers list, admin user pickers/lists, requests, proposal submitter card, chat messages,
// the messages menu, the leaderboard, the topbar account menu, and the profile page — so a badge
// added here shows up everywhere at once (SKILLY_SPEC.md §4, §19, §21).
// Hovering (or long-pressing on touch, or focusing) a bubble opens the directory hover card — the
// person's Entra job title / department / office, plus name, email, presence and their badges
// spelled out (§28).
import { useApi } from "./ui";
import { useDirectoryCard } from "./DirectoryCard";
import { BADGE_META, badgeLabel, type LeaderBadgeInfo } from "./leaderBadges";

export type { LeaderMetric, LeaderBadgeInfo } from "./leaderBadges";

const NO_BADGES: LeaderBadgeInfo[] = [];

/** One leader badge — a small colored, icon-filled circle below the avatar. The all-time variant
 *  is the same icon with a tiny crown overlaid on top (30-day carries no crown). Scales down with
 *  the bubble it sits under, floored so the icon stays legible even on the smallest avatars.
 *  No `title` tooltip: the hover card (§28) spells the badge out, and a native tooltip on the same
 *  element would race it. The aria-label stays for screen readers. */
function LeaderBadgeIcon({ badge, bubbleSize }: { badge: LeaderBadgeInfo; bubbleSize: number }) {
  const meta = BADGE_META[badge.metric];
  const dim = Math.max(11, Math.round(bubbleSize * 0.42));
  return (
    <span
      aria-label={badgeLabel(badge)}
      style={{
        position: "relative",
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: meta.color,
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontSize: Math.round(dim * 0.62),
        lineHeight: 1,
        flexShrink: 0,
        overflow: "visible",
      }}
    >
      <span aria-hidden style={{ transform: "translateY(0.5px)" }}>{meta.icon}</span>
      {badge.window === "all" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -Math.round(dim * 0.42),
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: Math.round(dim * 0.58),
            lineHeight: 1,
          }}
        >
          👑
        </span>
      )}
    </span>
  );
}

export function UserBubble({ name, avatar, size = 28, userId }: { name: string; avatar: string | null; size?: number; userId?: string | null }) {
  // Shared cached GET (components/ui.tsx) — every UserBubble instance on a page dedupes onto the
  // same one request, so badging is effectively free regardless of how many bubbles are on screen.
  const { data } = useApi<Record<string, LeaderBadgeInfo[]>>(userId ? "/api/leaders" : null);
  const badges = (userId ? data?.[userId] : undefined) ?? NO_BADGES;
  // The card reuses those same badges from memory — it never refetches them (§28).
  const { triggerProps, card } = useDirectoryCard(userId, name, badges);

  const bubble = avatar ? (
    // eslint-disable-next-line @next/next/no-img-element -- small data-URI avatar; next/image adds no value at this size
    <img {...triggerProps} src={avatar} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
  ) : (
    <div
      {...triggerProps}
      // Without a user id the bubble is inert and carries no label, so keep the initials out of
      // the accessibility tree exactly as before; with one, the trigger's aria-label names it.
      aria-hidden={userId ? undefined : true}
      style={{ width: size, height: size, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-2)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: size * 0.375, fontWeight: 600, flexShrink: 0 }}
    >
      <span aria-hidden>{name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"}</span>
    </div>
  );

  // No badges → render exactly as before (no wrapper, no layout change) for the overwhelming
  // majority of avatars that aren't a current leader of anything. The card is portalled to
  // <body>, so the fragment adds no layout of its own.
  if (badges.length === 0) {
    return (
      <>
        {bubble}
        {card}
      </>
    );
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
      {bubble}
      <span style={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center", maxWidth: size * 2 }}>
        {badges.map((b) => (
          <LeaderBadgeIcon key={`${b.metric}:${b.window}`} badge={b} bubbleSize={size} />
        ))}
      </span>
      {card}
    </span>
  );
}
