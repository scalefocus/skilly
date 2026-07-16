// Shared renderer for the static, app-wide social share card (SKILLY_SPEC.md §14), used by BOTH the
// opengraph-image and twitter-image routes so the card has a single implementation. Generated with
// next/og's ImageResponse — no binary is committed. One flat, two-color navy card (brand: navy field
// + the single cyan accent, white text), rendered in next/og's bundled default typeface (the
// vendored Montserrat is woff2-only, which Satori can't consume). Carries NO per-skill data — the
// card is app-wide, so nothing about a restricted skill can leak to an unauthenticated unfurl
// crawler (invariant #3). This is a plain module (not a route); the route files re-declare their own
// `runtime`/`alt`/`size`/`contentType` static exports and call renderSocialCard().
import { ImageResponse } from "next/og";
import { SITE_DESCRIPTION, SITE_TAGLINE, SITE_TITLE } from "./site-metadata";

export const SOCIAL_CARD_ALT = SITE_TITLE;
export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 };
export const SOCIAL_CARD_CONTENT_TYPE = "image/png";

// Scalefocus brand tokens (SKILLY_SPEC.md §14): navy field, the single cyan accent, white text.
const NAVY = "#082773";
const CYAN = "#14ABE3";
const WHITE = "#FFFFFF";

export function renderSocialCard(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: NAVY,
          padding: 96,
          color: WHITE,
        }}
      >
        {/* Wordmark: "skilly" closed by the brand's terminal cyan diamond (echoes the favicon). */}
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <div style={{ fontSize: 176, letterSpacing: -6, lineHeight: 1 }}>skilly</div>
          <div
            style={{
              width: 48,
              height: 48,
              marginLeft: 28,
              marginBottom: 30,
              backgroundColor: CYAN,
              borderRadius: 8,
              transform: "rotate(45deg)",
            }}
          />
        </div>
        <div style={{ display: "flex", marginTop: 32, fontSize: 56, color: CYAN }}>{SITE_TAGLINE}</div>
        <div
          style={{
            display: "flex",
            marginTop: 24,
            maxWidth: 900,
            fontSize: 30,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.72)",
          }}
        >
          {SITE_DESCRIPTION}
        </div>
      </div>
    ),
    { ...SOCIAL_CARD_SIZE },
  );
}
