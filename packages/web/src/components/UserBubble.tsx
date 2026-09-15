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
import { ACHIEVEMENT_TOTAL, levelAriaLabel } from "@skilly/shared/achievements";
import { ringDashArray, ringGeometry, showRing } from "./levelRing";

export type { LeaderMetric, LeaderBadgeInfo } from "./leaderBadges";

const NO_BADGES: LeaderBadgeInfo[] = [];

/** `GET /api/levels` (§31.10): one cached map per page, like `/api/leaders`. */
interface LevelMap { levels: Record<string, number>; heroes: string[] }

/** The achievement level as a ring around the avatar (§31.10) — an arc filled clockwise from
 *  twelve o'clock, in the platform accent. The ring sits OUTSIDE the avatar, so the photo and the
 *  initials circle are never cropped or shrunk; only a ringed bubble's footprint grows, exactly as
 *  the leader badges already grow it downwards.
 *
 *  Hero (the stored `hero_at` stamp, never `level === total`) draws a full ring plus §21's crown —
 *  the same "topped out" vocabulary the all-time leader badges already use on these bubbles. */
function LevelRing({ size, level, hero, children }: { size: number; level: number; hero: boolean; children: React.ReactNode }) {
  const { stroke, outer, center: c, radius: r } = ringGeometry(size);
  return (
    <span style={{ position: "relative", width: outer, height: outer, display: "inline-grid", placeItems: "center", flexShrink: 0 }}>
      <svg
        width={outer}
        height={outer}
        viewBox={`0 0 ${outer} ${outer}`}
        role="img"
        aria-label={levelAriaLabel(level, hero, ACHIEVEMENT_TOTAL)}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--accent-soft)" strokeWidth={stroke} />
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={hero ? "var(--ok)" : "var(--accent)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={ringDashArray(ringGeometry(size), level, hero, ACHIEVEMENT_TOTAL)}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </svg>
      {children}
      {hero && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -Math.round(outer * 0.3),
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: Math.max(9, Math.round(outer * 0.36)),
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          👑
        </span>
      )}
    </span>
  );
}

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
  // The level map is the same shape of shared, page-wide cached GET (§31.10). A user who opted out,
  // is inactive, or is at level 0 is simply absent from it — so no ring, and no client-side check.
  const { data: levelData } = useApi<LevelMap>(userId ? "/api/levels" : null);
  const level = (userId ? levelData?.levels?.[userId] : undefined) ?? 0;
  const hero = !!userId && !!levelData?.heroes?.includes(userId);
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

  // Level 0 → no ring at all, so a brand-new user's bubble is byte-for-byte what it was before this
  // feature (§31.10) — chat, request lists and admin tables don't sprout empty rings.
  const ringed = showRing(level) ? <LevelRing size={size} level={level} hero={hero}>{bubble}</LevelRing> : bubble;

  // No badges → render exactly as before (no wrapper, no layout change) for the overwhelming
  // majority of avatars that aren't a current leader of anything. The card is portalled to
  // <body>, so the fragment adds no layout of its own.
  if (badges.length === 0) {
    return (
      <>
        {ringed}
        {card}
      </>
    );
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
      {ringed}
      <span style={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center", maxWidth: size * 2 }}>
        {badges.map((b) => (
          <LeaderBadgeIcon key={`${b.metric}:${b.window}`} badge={b} bubbleSize={size} />
        ))}
      </span>
      {card}
    </span>
  );
}
