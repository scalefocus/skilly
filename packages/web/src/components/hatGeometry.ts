// New-user hat geometry (SKILLY_SPEC.md §67.3) — pure, so the sizing rules that keep the propeller
// beanie recognisable on a 20px chat avatar and proportional on a 52px profile one are unit-testable
// without rendering React. `NewUserHat.tsx` owns the SVG; this owns the numbers.

/** The SVG's own coordinate box: a 24-wide cap with its propeller, 17 tall. */
export const HAT_VIEW_WIDTH = 24;
export const HAT_VIEW_HEIGHT = 17;

/** Below this width the panels and propeller blur into a smudge. */
const MIN_WIDTH_PX = 12;
/** Hat width relative to what it sits on (the bubble, or its level ring). */
const WIDTH_RATIO = 0.56;
/** How much of the hat rises above the bubble's top edge; the rest sits on it, as if worn. */
const ABOVE_RATIO = 0.7;

export interface HatGeometry {
  width: number;
  height: number;
  /** Offset from the top of what it sits on — negative, so the hat overflows above it without
   *  changing the bubble's footprint (like the Hero crown, §31.10). */
  top: number;
}

/** `base` is the width of what the hat sits on: the avatar, or the level ring's outer size. */
export function hatGeometry(base: number): HatGeometry {
  const width = Math.max(MIN_WIDTH_PX, Math.round(base * WIDTH_RATIO));
  const height = Math.round((width * HAT_VIEW_HEIGHT) / HAT_VIEW_WIDTH);
  return { width, height, top: -Math.round(height * ABOVE_RATIO) };
}

/** Whether a bubble wears the hat: a new user who isn't a Hero — the crown takes that spot (§67.1
 *  decision 11). No user id, no hat (the bubble is inert, §28). */
export function showHat(userId: string | null | undefined, newcomerIds: readonly string[] | undefined, hero: boolean): boolean {
  return !!userId && !hero && !!newcomerIds?.includes(userId);
}
