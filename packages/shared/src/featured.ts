// "Featured skills" homepage spotlight — the platform cap (max number of skills that may be
// featured at once). Pure domain constants + validation, shared by the web settings layer and its
// tests. SKILLY_SPEC.md §7.

/** Default cap on how many skills can be Featured at once. */
export const FEATURED_MAX_DEFAULT = 10;
/** A cap of at least 1 (0 is not allowed — un-feature skills to empty the section). */
export const FEATURED_MAX_MIN = 1;
/** Upper bound so the homepage section can't be turned into an unbounded second catalog. */
export const FEATURED_MAX_MAX = 50;

/** True when `n` is a valid Featured cap (whole number within [MIN, MAX]). */
export function isValidFeaturedMax(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= FEATURED_MAX_MIN && (n as number) <= FEATURED_MAX_MAX;
}

/** Coerce a stored/unknown value into a valid cap, falling back to the default on anything malformed. */
export function coerceMaxFeatured(value: unknown): number {
  return isValidFeaturedMax(value) ? (value as number) : FEATURED_MAX_DEFAULT;
}

/** Throw a human-readable error if `n` is not a valid cap — used by the admin save path. */
export function assertMaxFeatured(n: number): void {
  if (!isValidFeaturedMax(n)) {
    throw new Error(`featured-skills cap must be a whole number between ${FEATURED_MAX_MIN} and ${FEATURED_MAX_MAX}`);
  }
}
