"use client";
import type { CSSProperties } from "react";
// The skill icon tile — every surface renders it the same way (§33.5): a neutral tile with a
// 1px border (so transparent PNGs survive both themes), the image `object-fit: cover`, an emoji
// centred, alt text = the skill title. `fallback="hide"` (the default) renders nothing when the
// skill has no icon — catalog/list/suggest/mention/installed surfaces. `fallback="default"`
// renders the skilly wordmark + diamond lockup instead — reserved for single-skill surfaces (the
// detail page header and the share card).
export interface SkillIconValue {
  url: string | null;
  emoji: string | null;
}

const NAVY = "#082773";
const CYAN = "#14abe3";

function DefaultLockup({ size }: { size: number }) {
  // A scaled-down echo of the app-wide social card's mark (§14): navy tile, cyan diamond.
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size, borderRadius: size >= 48 ? 12 : 8, background: NAVY,
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}
    >
      <div style={{ width: Math.round(size * 0.34), height: Math.round(size * 0.34), background: CYAN, borderRadius: Math.round(size * 0.08), transform: "rotate(45deg)" }} />
    </div>
  );
}

export function SkillIcon({
  icon,
  title,
  size = 40,
  fallback = "hide",
}: {
  icon: SkillIconValue | null | undefined;
  title: string;
  size?: number;
  fallback?: "hide" | "default";
}) {
  if (!icon || (!icon.url && !icon.emoji)) {
    return fallback === "default" ? <DefaultLockup size={size} /> : null;
  }
  const tileStyle: CSSProperties = {
    width: size, height: size, borderRadius: size >= 48 ? 12 : 8, flexShrink: 0,
    background: "var(--surface-2)", border: "1px solid var(--line)",
    display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
  };
  if (icon.url) {
    return (
      <div style={tileStyle}>
        <img src={icon.url} alt={title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div style={tileStyle} role="img" aria-label={title}>
      <span aria-hidden style={{ fontSize: Math.round(size * 0.62), lineHeight: 1 }}>{icon.emoji}</span>
    </div>
  );
}
