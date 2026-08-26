// Text helpers for the catalog/request card previews (SKILLY_SPEC.md §14 Fixed-height catalog
// cards). Kept free of React so they can be unit-tested directly; the card components and the §26
// requests page both import from here rather than keeping their own copies.

/** Descriptions support Markdown, but the card preview is a clamped plain-text block (full Markdown
 *  renders on the detail/review screens), so strip the markup to a single readable run. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The card description is clamped to 4 lines (§14), so the full text moves to a hover tooltip —
 *  capped, because a native `title` holding a whole Markdown body is unreadable and renders
 *  differently on every OS. The detail page remains the full read. */
export const DESC_TOOLTIP_MAX = 300;

export function descTooltip(md: string): string {
  const t = plainText(md);
  return t.length > DESC_TOOLTIP_MAX ? `${t.slice(0, DESC_TOOLTIP_MAX).trimEnd()}\u2026` : t;
}
