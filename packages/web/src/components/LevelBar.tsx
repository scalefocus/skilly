"use client";
// The achievement level bar (SKILLY_SPEC.md §31.10) — the same number the bubble's ring draws,
// as a labelled progress bar. Used by the profile Achievements card (where it replaces the old
// "N of M earned" text line) and by the hall header at a larger size.
//
// "Hero" always comes from the stored `heroAt` stamp, never from `level === total`: once the
// catalog grows past a Hero's tally the two stop being the same thing, and the Hero keeps the crown.
import { useEffect, useState } from "react";
import { levelAriaLabel, levelFraction, levelLabel } from "@skilly/shared/achievements";
import { useDateFmt } from "./DateFormat";

export function LevelBar({
  level,
  total,
  heroAt,
  large = false,
}: {
  level: number;
  total: number;
  /** UTC ISO of when they first held the whole catalog, or null. Presence of a date IS Hero. */
  heroAt?: string | null;
  /** Hall header sizing — a taller track and a bigger label than the profile card's. */
  large?: boolean;
}) {
  const fmt = useDateFmt();
  const hero = !!heroAt;
  const target = levelFraction(level, hero, total);

  // Fill from empty on mount (~400ms, CSS); `prefers-reduced-motion` kills the transition in CSS,
  // so the bar simply appears at its value.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(target));
    return () => cancelAnimationFrame(id);
  }, [target]);

  return (
    <div className={`level-bar${large ? " level-bar-lg" : ""}`} data-testid="level-bar" data-level={level} data-hero={hero ? "1" : "0"}>
      <div className="level-bar-label">
        <span className={hero ? "level-bar-hero" : undefined}>{levelLabel(level, hero, total)}</span>
        {hero && heroAt && <span className="level-bar-since">Hero since {fmt.date(heroAt)}</span>}
      </div>
      <div
        className="level-bar-track"
        role="progressbar"
        aria-valuenow={level}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={levelAriaLabel(level, hero, total)}
      >
        <span className={`level-bar-fill${hero ? " level-bar-fill-hero" : ""}`} style={{ width: `${width * 100}%` }} />
      </div>
    </div>
  );
}
