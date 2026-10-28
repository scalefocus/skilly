// The skill page's Quality card open/closed rules (SKILLY_SPEC.md §41.7). Collapsed by default, with
// ONE global preference shared by every skill's card. A `#quality` deep link opens the card for that
// view only — it never writes the preference, so one notification click doesn't flip the default.
import { storedFlagOpen } from "./facetRow";

/** The deep-link fragment (the §41.9 notification CTA, and `?draft=ai#quality` from §44.9). */
export const QUALITY_HASH = "#quality";

/** What the card does on arrival: the stored preference, or forced open by a `#quality` link. */
export function initialQualityCardOpen(stored: string | null | undefined, hash: string): boolean {
  return hash === QUALITY_HASH || storedFlagOpen(stored);
}
