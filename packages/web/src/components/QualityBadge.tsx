"use client";
import { formatStars, type QualityMode } from "@skilly/shared/quality";
import { useAiName } from "./AiName";

/** The skill-level quality summary a catalog surface carries (§41.11). */
export interface QualitySummaryView { score: number; stars: number; mode: QualityMode; scoredAt?: string }

/** `aiName` is the §40.14 display name. */
export function qualityTooltip(q: QualitySummaryView, aiName = "AI"): string {
  return `Quality ${formatStars(q.stars)} / 5 (${q.score}) — computed by skilly from the authoring rules${q.mode === "rules+ai" ? ` and an assessment by ${aiName}` : " only"}`;
}

/**
 * The system-computed quality badge (§41.7): a shield glyph in the accent colour plus the
 * half-star value. Deliberately not the gold ★ of the user rating. Renders nothing while unscored.
 */
export function QualityBadge({ quality, label = false }: { quality?: QualitySummaryView | null; label?: boolean }) {
  const aiName = useAiName();
  if (!quality) return null;
  return (
    <span className="quality-badge" title={qualityTooltip(quality, aiName)} data-testid="quality-badge" aria-label={`Quality ${formatStars(quality.stars)} out of 5`}>
      <span className="quality-glyph" aria-hidden>⛨</span>
      {label && <span className="quality-label">Quality</span>}
      {formatStars(quality.stars)}
    </span>
  );
}

/** Five half-star glyphs for a stars value (the Quality card and the Versions list). */
export function QualityStars({ stars, size = 18 }: { stars: number; size?: number }) {
  return (
    <span className="quality-stars" aria-label={`${formatStars(stars)} out of 5`} style={{ fontSize: size }}>
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = stars >= i ? "full" : stars >= i - 0.5 ? "half" : "empty";
        return <span key={i} className={`quality-star quality-star-${fill}`} aria-hidden>{fill === "empty" ? "☆" : "★"}</span>;
      })}
    </span>
  );
}
