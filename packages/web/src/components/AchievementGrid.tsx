"use client";
// Achievement tiles (SKILLY_SPEC.md §31.5) — one grid shared by the profile card (owner view:
// every badge, locked ones greyed with a how-to-earn hint) and the hall (earned only for others).
// Visual language follows the leader badges (§21): a glyph in a coloured circle. A locked badge whose
// feature is switched off for the owner says so instead of giving its how-to hint (§31.12.4), and
// copy naming the AI uses the §40.14 display name (§31.12.5).
import { useEffect, useRef } from "react";
import {
  ACHIEVEMENTS, ACHIEVEMENT_GROUPS, UNAVAILABLE_HINT, achievementCopy, type AchievementDef, type AchievementGroup,
} from "@skilly/shared/achievements";
import { useAiName } from "./AiName";
import { useDateFmt } from "./DateFormat";
import { ShareButton } from "./ui";

export interface EarnedBadge { key: string; earnedAt: string }
export interface AchievementsView {
  userId: string;
  displayName: string;
  avatar: string | null;
  hidden: boolean;
  earned: EarnedBadge[];
  total: number;
  /** §31.10 — when they first held the whole catalog, or null. Null while `hidden`. */
  heroAt: string | null;
  /** §35.4 — the hall's Follow button shows only when true (and never on your own hall). */
  followable?: boolean;
  /** §31.12.4 — the owner's locked keys whose feature is switched off; empty for anyone else. */
  unavailable?: string[];
}

const GROUP_COLOR: Record<AchievementGroup, string> = {
  Consume: "var(--accent)",
  Ask: "var(--accent-2)",
  Contribute: "var(--ok)",
  Talk: "var(--warn)",
  Explore: "var(--accent)",
  Habits: "var(--ink)",
};

export function AchievementGrid({
  earned,
  showLocked,
  spotlight,
  shareBase,
  recentFirst = false,
  unavailable = [],
}: {
  earned: EarnedBadge[];
  /** Owner view: render locked badges (greyed, with the hint). Others see earned only. */
  showLocked: boolean;
  /** `?badge=<key>` — scroll that earned tile into view and flash it. Unknown/unearned = ignored. */
  spotlight?: string | null;
  /** When set, each earned tile gets a small share affordance copying `<shareBase>?badge=<key>`. */
  shareBase?: string;
  /** Hall view: a flat list, most recent first, instead of the grouped catalog order. */
  recentFirst?: boolean;
  /** Owner view: locked keys whose feature is switched off — their hint says so (§31.12.4). */
  unavailable?: string[];
}) {
  const fmt = useDateFmt();
  const aiName = useAiName();
  const off = new Set(unavailable);
  const earnedAt = new Map(earned.map((e) => [e.key, e.earnedAt]));
  const flashed = useRef<string | null>(null);

  useEffect(() => {
    if (!spotlight || !earnedAt.has(spotlight) || flashed.current === spotlight) return;
    const el = document.querySelector<HTMLElement>(`[data-badge="${CSS.escape(spotlight)}"]`);
    if (!el) return;
    flashed.current = spotlight;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("card-flash");
    const t = setTimeout(() => el.classList.remove("card-flash"), 1300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlight, earned.length]);

  const tile = (a: AchievementDef) => {
    const at = earnedAt.get(a.key) ?? null;
    if (!at && !showLocked) return null;
    const copy = achievementCopy(a, aiName);
    const unavailableHere = !at && off.has(a.key);
    return (
      <div
        key={a.key}
        className={`ach-tile${at ? "" : " ach-tile-locked"}`}
        data-badge={a.key}
        data-earned={at ? "1" : "0"}
        data-unavailable={unavailableHere ? "1" : undefined}
        aria-label={`${a.name}${at ? "" : " (locked)"}`}
      >
        <span className="ach-glyph" style={{ background: GROUP_COLOR[a.group] }} aria-hidden>{a.glyph}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ach-name">{a.name}</div>
          <div className="ach-text">{at ? copy.blurb : unavailableHere ? UNAVAILABLE_HINT : copy.howToEarn}</div>
          {at && <div className="ach-date">Earned {fmt.date(at)}</div>}
        </div>
        {at && shareBase && (
          <span className="ach-share">
            <ShareButton url={`${shareBase}?badge=${encodeURIComponent(a.key)}`} label="" title={`Copy a link to ${a.name}`} />
          </span>
        )}
      </div>
    );
  };

  if (recentFirst) {
    const list = [...earned]
      .sort((x, y) => y.earnedAt.localeCompare(x.earnedAt))
      .map((e) => ACHIEVEMENTS.find((a) => a.key === e.key))
      .filter((a): a is AchievementDef => !!a);
    return <div className="ach-grid">{list.map(tile)}</div>;
  }

  return (
    <>
      {ACHIEVEMENT_GROUPS.map((g) => {
        const defs = ACHIEVEMENTS.filter((a) => a.group === g);
        const tiles = defs.map(tile).filter(Boolean);
        if (tiles.length === 0) return null;
        return (
          <div key={g} className="ach-group">
            <h3 className="ach-group-title">{g}</h3>
            <div className="ach-grid">{tiles}</div>
          </div>
        );
      })}
    </>
  );
}
