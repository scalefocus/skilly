// Twitter card route (SKILLY_SPEC.md §14) — the same static, app-wide card as the Open Graph route,
// rendered from the shared renderSocialCard(); `twitter:card = summary_large_image` is set in
// site-metadata's buildMetadata. See social-card.tsx for the design + invariant-#3 rationale.
import { renderSocialCard, SOCIAL_CARD_ALT, SOCIAL_CARD_CONTENT_TYPE, SOCIAL_CARD_SIZE } from "./social-card";

// Never Edge — skilly is self-hosted standalone Node (SKILLY_SPEC.md §2). Must be a local literal:
// Next reads `runtime` via static analysis, so a re-exported/imported value isn't recognized.
export const runtime = "nodejs";

export const alt = SOCIAL_CARD_ALT;
export const size = SOCIAL_CARD_SIZE;
export const contentType = SOCIAL_CARD_CONTENT_TYPE;

export default function TwitterImage() {
  return renderSocialCard();
}
