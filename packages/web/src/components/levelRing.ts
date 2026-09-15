// Level-ring geometry (SKILLY_SPEC.md §31.10) — pure, so the sizing rules that keep the ring
// legible on a 20px chat avatar and proportional on a 52px profile one are unit-testable without
// rendering React. `UserBubble` owns the SVG; this owns the numbers.
import { levelFraction } from "@skilly/shared/achievements";

export interface RingGeometry {
  /** Arc width. Scales with the bubble but is FLOORED so it survives the smallest avatars. */
  stroke: number;
  /** Total footprint. The avatar keeps its own `size`; only the ring's own width is added, so a
   *  photo is never cropped or shrunk — the bubble just grows the way leader badges already grow it. */
  outer: number;
  /** Centre of the ring, in the SVG's own coordinates. */
  center: number;
  radius: number;
  circumference: number;
}

/** Breathing room between the arc and the avatar's edge. */
const GAP_PX = 1;
const MIN_STROKE_PX = 2;

export function ringGeometry(size: number): RingGeometry {
  const stroke = Math.max(MIN_STROKE_PX, Math.round(size * 0.08));
  const outer = size + 2 * (stroke + GAP_PX);
  const radius = (outer - stroke) / 2;
  return { stroke, outer, center: outer / 2, radius, circumference: 2 * Math.PI * radius };
}

/**
 * Whether a bubble draws a ring at all. Level 0 draws nothing — a user with no badges renders
 * byte-for-byte the bubble they rendered before this feature, which is what keeps chat, request
 * lists and admin tables from sprouting empty rings around everyone who never engaged (§31.10).
 */
export function showRing(level: number): boolean {
  return level >= 1;
}

/** The dash pattern for the filled arc: `${filled} ${circumference}` leaves the rest empty. */
export function ringDashArray(g: RingGeometry, level: number, hero: boolean, total?: number): string {
  return `${g.circumference * levelFraction(level, hero, total)} ${g.circumference}`;
}
