"use client";
// A 1–5 star control for forms (SKILLY_SPEC.md §36.4): the skill-detail rating's look (.star-input
// / .star / .star-on, hover preview) without its save-on-click. The value is local form state;
// clicking the selected star again clears it, so every question stays optional.
//
// Keyboard: a radiogroup of five radios with a roving tabindex — Tab reaches the group once, the
// arrow keys move AND select, Home/End jump, Space/Enter selects, Delete/Backspace clears.
import { useRef, useState } from "react";

export function StarInput({
  value,
  onChange,
  label,
  labelledBy,
  disabled = false,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  /** The accessible name (or use `labelledBy`). */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = hover ?? value ?? 0;
  // The roving tab stop: the selected star, or the first when nothing is selected.
  const tabStop = value ?? 1;

  const select = (star: number, focus = false) => {
    onChange(star);
    if (focus) refs.current[star - 1]?.focus();
  };

  const onKey = (e: React.KeyboardEvent, star: number) => {
    const move = (to: number) => {
      e.preventDefault();
      select(Math.min(5, Math.max(1, to)), true);
    };
    if (e.key === "ArrowRight" || e.key === "ArrowUp") move(star + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") move(star - 1);
    else if (e.key === "Home") move(1);
    else if (e.key === "End") move(5);
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onChange(null);
    }
  };

  return (
    <div
      className="star-input"
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      onMouseLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          ref={(el) => { refs.current[star - 1] = el; }}
          type="button"
          role="radio"
          aria-checked={value === star}
          aria-label={`${star} star${star === 1 ? "" : "s"}`}
          tabIndex={star === tabStop ? 0 : -1}
          disabled={disabled}
          className={`star${star <= shown ? " star-on" : ""}`}
          onMouseEnter={() => setHover(star)}
          onClick={() => onChange(value === star ? null : star)}
          onKeyDown={(e) => onKey(e, star)}
        >
          ★
        </button>
      ))}
      <span className="sr-only" aria-live="polite">{value == null ? "Not answered" : ""}</span>
    </div>
  );
}
