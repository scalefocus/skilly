"use client";
// The achievements hall (SKILLY_SPEC.md §31.5): a person's earned badges, shareable by URL with any
// signed-in colleague. Others see earned badges only; the owner also sees the locked ones with
// their hints (the same content as the profile card). `?badge=<key>` spotlights one tile.
import { useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useApi, EmptyState, ScrollToTop, ShareButton } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { UserBubble } from "../../../components/UserBubble";
import { FollowButton } from "../../../components/FollowButton";
import { AchievementGrid, type AchievementsView } from "../../../components/AchievementGrid";
import { LevelBar } from "../../../components/LevelBar";
import { usePageLabelOverride } from "../../../components/PageLabelOverride";
import { reportFeatureUse } from "../../../lib/surveyClient";

interface CardData { jobTitle: string | null; officeLocation: string | null; department: string | null }

function HallInner() {
  // §36.3 opening an achievements hall is the `achievements` feature's first use.
  useEffect(() => { reportFeatureUse("achievements"); }, []);
  const { userId } = useParams<{ userId: string }>();
  const params = useSearchParams();
  const spotlight = params.get("badge");
  const { data: me } = useApi<{ userId: string | null }>("/api/me");
  const { data, loading, error } = useApi<AchievementsView | { disabled: true }>(userId ? `/api/users/${userId}/achievements` : null);
  const view = data && !("disabled" in data) ? data : null;
  // The directory block exactly as the hover card would show it (honours the person's opt-out).
  const { data: card } = useApi<CardData>(view ? `/api/users/${userId}/card` : null);
  usePageLabelOverride(view ? `Achievements: ${view.displayName}` : null);

  if (error) return <EmptyState icon="🏆" title="No such hall" hint="This person doesn't exist here, or their account is no longer active." />;
  if (loading || !data) return <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />;

  if ("disabled" in data) {
    return (
      <div className="reveal" style={{ maxWidth: 760 }}>
        <div className="card reveal" style={{ padding: 16, borderColor: "var(--warn-line, var(--line))" }}>
          <strong style={{ fontSize: 14 }}>Achievements are switched off</strong>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: "6px 0 0", lineHeight: 1.6 }}>
            A platform administrator has disabled them for this registry. Badges keep being recorded quietly and
            everything reappears if they are switched back on.
          </p>
        </div>
      </div>
    );
  }

  const isSelf = !!me?.userId && me.userId === data.userId;
  const dirLines = card
    ? ([["Title", card.jobTitle], ["Department", card.department], ["Office", card.officeLocation]] as const).filter(([, v]) => !!v)
    : [];

  return (
    <div className="reveal" style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head">
        <div className="eyebrow">Achievements</div>
        <h1 className="page-title">{isSelf ? "Your hall." : `${data.displayName}'s hall.`}</h1>
      </div>

      <section className="card card-pad reveal" style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <UserBubble name={data.displayName} avatar={data.avatar} userId={data.userId} size={52} />
        {/* A flex BASIS, not `flex: 1`: at phone widths a shrink-to-zero column squeezes the name,
            the directory line and the level bar into a stub instead of wrapping the actions below. */}
        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{data.displayName}</div>
          {dirLines.length > 0 && (
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {dirLines.map(([, v]) => v).join(" · ")}
            </div>
          )}
          {/* §31.10 — the level, big, in the header. Suppressed for a hidden person seen by anyone
              else: the bar would restate the very count the opt-out withholds (§31.5). */}
          {!data.hidden && (
            <div style={{ marginTop: 10, maxWidth: 380 }}>
              <LevelBar level={data.earned.length} total={data.total} heroAt={data.heroAt} large />
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <ShareButton label="Share" title="Copy a link to this hall" />
          {/* §35.4 — next to Share on someone else's hall; shown even when their trophies are private. */}
          {!isSelf && <FollowButton userId={data.userId} followable={data.followable === true} name={data.displayName} />}
          {isSelf && <Link href="/profile#achievements" className="btn-ghost mono" style={{ fontSize: 12 }}>Manage →</Link>}
        </div>
      </section>

      {data.hidden ? (
        <p className="muted" data-testid="hall-private" style={{ fontSize: 14 }}>{data.displayName} keeps their trophies private.</p>
      ) : (
        <section className="card card-pad reveal">
          {/* No footer total: the header's level bar already carries the N of M count (§31.5). */}
          <AchievementGrid earned={data.earned} showLocked={isSelf} spotlight={spotlight} recentFirst={!isSelf} />
        </section>
      )}
    </div>
  );
}

export default function AchievementsHallPage() {
  return (
    <RequireAuth>
      <HallInner />
    </RequireAuth>
  );
}
