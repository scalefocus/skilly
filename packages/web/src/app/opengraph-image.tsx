// Open Graph social card route (SKILLY_SPEC.md §14) — the static, app-wide card. The card itself is
// rendered by the shared renderSocialCard() so the OG and Twitter routes stay identical; see
// social-card.tsx for the design + the invariant-#3 rationale (app-wide, no per-skill data).
import { renderSocialCard, SOCIAL_CARD_ALT, SOCIAL_CARD_CONTENT_TYPE, SOCIAL_CARD_SIZE } from "./social-card";

// Never Edge — skilly is self-hosted standalone Node (SKILLY_SPEC.md §2). Must be a local literal:
// Next reads `runtime` via static analysis, so a re-exported/imported value isn't recognized.
export const runtime = "nodejs";

export const alt = SOCIAL_CARD_ALT;
export const size = SOCIAL_CARD_SIZE;
export const contentType = SOCIAL_CARD_CONTENT_TYPE;

export default function OpengraphImage() {
  return renderSocialCard();
}
