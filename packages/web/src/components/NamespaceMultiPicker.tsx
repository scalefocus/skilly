"use client";
// "Share with namespaces" picker (SKILLY_SPEC.md §42.3): a CLOSED multi-select over the org's
// namespaces — search by display name or slug, add several, remove with ×. Unlike TagInput there
// is no "create" row: only existing namespaces can be picked. Value = namespace ids. Reuses the
// TagInput look (`.taginput*`) so the propose form, the review page and the detail page's Shared
// with card all feel the same. Defined at module scope so typing never remounts the input.
import { useEffect, useMemo, useRef, useState } from "react";

export interface NamespaceOption {
  id: string;
  slug: string;
  displayName: string;
}

/** Fetch the share-target directory once per mount (all namespaces except `global`). */
export function useShareTargets(): NamespaceOption[] {
  const [opts, setOpts] = useState<NamespaceOption[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/namespaces/share-targets")
      .then((r) => (r.ok ? r.json() : { namespaces: [] }))
      .then((j: { namespaces?: NamespaceOption[] }) => { if (alive) setOpts(j.namespaces ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return opts;
}

const norm = (s: string) => s.trim().toLowerCase();

export function NamespaceMultiPicker({
  value,
  onChange,
  options,
  exclude = [],
  disabled = false,
  placeholder = "Search namespaces to share with…",
  ariaLabel = "Share with namespaces",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: NamespaceOption[];
  /** ids never offered (the owning namespace). */
  exclude?: string[];
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const selected = useMemo(() => new Set(value), [value]);
  const excluded = useMemo(() => new Set(exclude), [exclude]);

  const matches = useMemo(() => {
    const q = norm(text);
    return options
      .filter((o) => !selected.has(o.id) && !excluded.has(o.id))
      .filter((o) => q === "" || norm(o.displayName).includes(q) || o.slug.includes(q))
      .slice(0, 8);
  }, [options, selected, excluded, text]);

  const add = (id: string) => {
    if (!id || selected.has(id) || excluded.has(id)) return;
    onChange([...value, id]);
    setText("");
    setHi(0);
  };
  const remove = (id: string) => onChange(value.filter((v) => v !== id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[hi];
      if (m) add(m.id);
    } else if (e.key === "Backspace" && text === "" && value.length) {
      remove(value[value.length - 1]!);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="taginput" onClick={() => !disabled && inputRef.current?.focus()} aria-disabled={disabled || undefined}>
      <div className="taginput-box">
        {value.map((id) => {
          const o = byId.get(id);
          const label = o?.displayName ?? "Unknown namespace";
          return (
            <span key={id} className="chip chip-accent taginput-chip" title={o ? `@${o.slug}` : id}>
              {label}
              {!disabled && (
                <button type="button" aria-label={`stop sharing with ${label}`} onClick={(e) => { e.stopPropagation(); remove(id); }}>×</button>
              )}
            </span>
          );
        })}
        {!disabled && (
          <input
            ref={inputRef}
            value={text}
            aria-label={ariaLabel}
            placeholder={value.length === 0 ? placeholder : ""}
            onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {open && !disabled && matches.length > 0 && (
        <div className="taginput-menu" role="listbox">
          {matches.map((o, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === hi}
              key={o.id}
              className={`taginput-opt${i === hi ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); add(o.id); }}
            >
              {o.displayName} <span className="muted">@{o.slug}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
