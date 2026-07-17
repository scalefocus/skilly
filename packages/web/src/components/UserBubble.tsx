"use client";
// Profile bubble: an Entra photo (captured at the user's own sign-in, stored as a data URI) or
// initials when absent. Shared by every place a user's avatar appears — the skill-detail
// Maintainers list, admin user pickers/lists, requests, proposal submitter card, chat messages,
// the messages menu, the leaderboard, the topbar account menu, and the profile page — so a badge
// added here shows up everywhere at once (SKILLY_SPEC.md §4, §19, §21).
import { useApi } from "./ui";

export type LeaderMetric = "installs" | "skills" | "requests" | "watched";
export interface LeaderBadgeInfo { metric: LeaderMetric; window: "all" | "30d" }

const BADGE_META: Record<LeaderMetric, { icon: string; color: string; label: string }> = {
  installs: { icon: "📥", color: "var(--accent)", label: "Installs leader" },
  skills: { icon: "📝", color: "var(--accent-2)", label: "Adoption leader" },
  requests: { icon: "🎁", color: "var(--ok)", label: "Fulfillment leader" },
  watched: { icon: "👁", color: "var(--warn)", label: "Watch leader" },
};

/** One leader badge — a small colored, icon-filled circle below the avatar. The all-time variant
 *  is the same icon with a tiny crown overlaid on top (30-day carries no crown). Scales down with
 *  the bubble it sits under, floored so the icon stays legible even on the smallest avatars. */
function LeaderBadgeIcon({ badge, bubbleSize }: { badge: LeaderBadgeInfo; bubbleSize: number }) {
  const meta = BADGE_META[badge.metric];
  const dim = Math.max(11, Math.round(bubbleSize * 0.42));
  const windowLabel = badge.window === "all" ? "all time" : "last 30 days";
  return (
    <span
      title={`${meta.label} — ${windowLabel}`}
      aria-label={`${meta.label} — ${windowLabel}`}
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
  const badges = userId ? data?.[userId] : undefined;

  const bubble = avatar ? (
    // eslint-disable-next-line @next/next/no-img-element -- small data-URI avatar; next/image adds no value at this size
    <img src={avatar} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
  ) : (
    <div
      aria-hidden
      style={{ width: size, height: size, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-2)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: size * 0.375, fontWeight: 600, flexShrink: 0 }}
    >
      {name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"}
    </div>
  );

  // No badges → render exactly as before (no wrapper, no layout change) for the overwhelming
  // majority of avatars that aren't a current leader of anything.
  if (!badges || badges.length === 0) return bubble;

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
      {bubble}
      <span style={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center", maxWidth: size * 2 }}>
        {badges.map((b) => (
          <LeaderBadgeIcon key={`${b.metric}:${b.window}`} badge={b} bubbleSize={size} />
        ))}
      </span>
    </span>
  );
}
