// The new-user hat (SKILLY_SPEC.md §66.3): a generic propeller beanie — four coloured panels, a band
// and a little propeller on top. Static, and fixed colours in both themes like the leader badges
// (§21). Used above a new user's avatar bubble and, smaller, in their hover card's New user row.
import { HAT_VIEW_HEIGHT, HAT_VIEW_WIDTH } from "./hatGeometry";

// Points on the dome: a radius-9 half circle centred on (12, 15), split into four 45° panels.
const PANELS: { d: string; fill: string }[] = [
  { d: "M12 15 L3 15 A9 9 0 0 1 5.636 8.636 Z", fill: "#e02424" },
  { d: "M12 15 L5.636 8.636 A9 9 0 0 1 12 6 Z", fill: "#2563eb" },
  { d: "M12 15 L12 6 A9 9 0 0 1 18.364 8.636 Z", fill: "#ffd21f" },
  { d: "M12 15 L18.364 8.636 A9 9 0 0 1 21 15 Z", fill: "#16a34a" },
];

/** `label` makes it a named image (on an avatar); without one it is decorative (next to text). */
export function NewUserHat({ width, height, label }: { width: number; height: number; label?: string }) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      {...a11y}
      width={width}
      height={height}
      viewBox={`0 0 ${HAT_VIEW_WIDTH} ${HAT_VIEW_HEIGHT}`}
      focusable="false"
      data-testid="new-user-hat"
      style={{ display: "block", overflow: "visible", flexShrink: 0 }}
    >
      {/* propeller: stem, two blades, hub */}
      <rect x="11.45" y="2.8" width="1.1" height="3.6" fill="#4a4f57" />
      <ellipse cx="8.4" cy="2.6" rx="3.6" ry="1.25" fill="#ffd21f" stroke="rgba(0,0,0,0.28)" strokeWidth="0.4" />
      <ellipse cx="15.6" cy="2.6" rx="3.6" ry="1.25" fill="#e02424" stroke="rgba(0,0,0,0.28)" strokeWidth="0.4" />
      <circle cx="12" cy="2.6" r="1.15" fill="#4a4f57" />
      {/* dome panels with a hairline so the cap reads on light and dark backgrounds */}
      {PANELS.map((p) => (
        <path key={p.d} d={p.d} fill={p.fill} stroke="rgba(0,0,0,0.28)" strokeWidth="0.45" strokeLinejoin="round" />
      ))}
      {/* band */}
      <rect x="2.2" y="14" width="19.6" height="2.4" rx="1.2" fill="#2f3540" />
    </svg>
  );
}
