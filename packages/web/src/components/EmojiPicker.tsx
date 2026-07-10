"use client";
// Tiny built-in emoji picker — a curated grid, no external library. Calls onPick with the chosen
// native unicode emoji so the composer can insert it at the cursor. SKILLY_SPEC.md §24.
import { useEffect, useRef, useState } from "react";

const EMOJI = [
  "👍", "👎", "🙌", "👏", "🙏", "💪", "🤝", "👀",
  "😀", "😄", "😉", "🙂", "😅", "😂", "🤔", "😎",
  "🎉", "🚀", "🔥", "✨", "⭐", "💡", "✅", "❌",
  "⚠️", "🐛", "🔒", "📦", "📝", "❤️", "💬", "👋",
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="btn-ghost"
        aria-label="Insert emoji"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", width: 36, height: 36, padding: 0, fontSize: 18, lineHeight: 1.1, overflow: "visible", borderRadius: "var(--radius-sm)" }}
      >
        🙂
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 30, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow)", padding: 6, display: "grid", gridTemplateColumns: "repeat(8, 30px)", gap: 2, width: "max-content", maxWidth: "calc(100vw - 24px)", boxSizing: "border-box" }}>
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { onPick(e); setOpen(false); }}
              style={{ background: "none", border: 0, cursor: "pointer", fontSize: 18, lineHeight: 1.1, padding: 0, borderRadius: 6, width: 30, height: 32, minWidth: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", overflow: "visible" }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = "none")}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
