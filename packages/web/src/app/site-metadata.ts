// Root site metadata + the static, app-wide social share card's shared strings (SKILLY_SPEC.md §14).
// `buildMetadata` is a pure function (env in → Metadata out) so the metadataBase derivation and its
// graceful degradation stay unit-testable without the Next runtime. The Open Graph / Twitter image
// itself is produced by the co-located `opengraph-image` / `twitter-image` file conventions, which
// Next merges into this metadata. The card is deliberately static and app-wide — it carries NO
// per-skill data, because the server returns 200 to unauthenticated unfurl crawlers (client-side
// auth gating), so a per-skill card would leak restricted skills (invariant #3).
import type { Metadata } from "next";

export const SITE_NAME = "skilly";
export const SITE_TITLE = "skilly — agent skills registry";
export const SITE_TAGLINE = "Agent skills registry";
export const SITE_DESCRIPTION =
  "Self-hosted registry for governing SKILL.md agent skills, anchored in Microsoft Entra ID.";

/**
 * Parse PUBLIC_BASE_URL into a `metadataBase` URL. Unset / blank / unparseable → undefined: Next
 * then emits relative image refs and nothing breaks (graceful degradation, mirroring the §12
 * email-CTA "no PUBLIC_BASE_URL → degrade" posture). An og:image URL must be absolute for external
 * unfurlers, so a configured PUBLIC_BASE_URL is what makes the social preview fully resolvable.
 */
export function parseBaseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed);
  } catch {
    return undefined;
  }
}

/** Build the root-layout metadata from the environment. Pure (no I/O) for testability. */
export function buildMetadata(publicBaseUrl: string | undefined): Metadata {
  return {
    metadataBase: parseBaseUrl(publicBaseUrl),
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
    },
  };
}
