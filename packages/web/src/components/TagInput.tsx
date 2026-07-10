"use client";
import { useMemo, useRef, useState } from "react";

// Tag-style multi-select combobox: search existing options, add several, or create new ones
// on the fly. Defined at module scope (stable identity) so typing never remounts the input —
// the field keeps focus across keystrokes.

const norm = (s: string) => s.trim().toLowerCase();

export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "Add…",
  max = 12,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  max?: number;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(value.map(norm)), [value]);

  const matches = useMemo(() => {
    const q = norm(text);
    return suggestions.filter((s) => !selectedSet.has(norm(s)) && (q === "" || norm(s).includes(q))).slice(0, 8);
  }, [suggestions, selectedSet, text]);

  const typedIsNew = text.trim() !== "" && !suggestions.some((s) => norm(s) === norm(text)) && !selectedSet.has(norm(text));
  // Options shown in the dropdown: a synthetic "create" row first when the typed value is new.
  const options = typedIsNew ? [{ kind: "create" as const, label: text.trim() }, ...matches.map((m) => ({ kind: "use" as const, label: m }))] : matches.map((m) => ({ kind: "use" as const, label: m }));

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v || selectedSet.has(norm(v)) || value.length >= max) {
      setText("");
      return;
    }
    onChange([...value, v]);
    setText("");
    setHi(0);
  };
  const removeAt = (i: number) => onChange(value.filter((_, j) => j !== i));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const opt = options[hi];
      add(opt ? opt.label : text);
    } else if (e.key === "Backspace" && text === "" && value.length) {
      removeAt(value.length - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(h + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="taginput" onClick={() => inputRef.current?.focus()}>
      <div className="taginput-box">
        {value.map((t, i) => (
          <span key={`${t}-${i}`} className="chip chip-accent taginput-chip">
            {t}
            <button type="button" aria-label={`remove ${t}`} onClick={(e) => { e.stopPropagation(); removeAt(i); }}>×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          placeholder={value.length === 0 ? placeholder : ""}
          onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && options.length > 0 && (
        <div className="taginput-menu">
          {options.map((o, i) => (
            <button
              type="button"
              key={`${o.kind}-${o.label}`}
              className={`taginput-opt${i === hi ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); add(o.label); }}
            >
              {o.kind === "create" ? <>Create <strong>“{o.label}”</strong></> : o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
