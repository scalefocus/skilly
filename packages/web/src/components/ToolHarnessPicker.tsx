"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TOOL_OPTIONS, agentLabel, GENERIC_AGENT } from "@skilly/shared/agents";

// Closed-but-searchable picker for a skill's tool/harness (coding agent). The label is shown; the
// slug is stored via onChange. Filtering matches label OR slug; `Generic` (default) sits first.
// SKILLY_SPEC.md §3/§8. When `disabled` (new-version lock) it renders a read-only label.
export function ToolHarnessPicker({ value, onChange, disabled, style }: {
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!editing || !needle) return TOOL_OPTIONS;
    return TOOL_OPTIONS.filter((o) => o.label.toLowerCase().includes(needle) || o.slug.includes(needle));
  }, [q, editing]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); setEditing(false); }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (disabled) {
    return <input style={style} value={agentLabel(value)} disabled readOnly />;
  }

  const pick = (slug: string) => { onChange(slug); setOpen(false); setEditing(false); setQ(""); };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        style={style}
        // Show the selected label when idle; clear to a search box while editing.
        value={editing ? q : agentLabel(value)}
        onChange={(e) => { setEditing(true); setOpen(true); setQ(e.target.value); }}
        onFocus={() => { setOpen(true); setEditing(true); setQ(""); }}
        placeholder="Search a tool… (default: Generic)"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
      />
      {open && (
        <div className="taginput-menu" role="listbox" style={{ maxHeight: 280, overflowY: "auto" }}>
          {matches.length === 0 ? (
            <div className="taginput-opt muted" aria-disabled>No matching tool</div>
          ) : (
            matches.map((o) => (
              <button key={o.slug} type="button" className="taginput-opt" aria-selected={o.slug === value} onClick={() => pick(o.slug)}>
                {o.label}
                {o.slug !== GENERIC_AGENT && <span className="muted mono" style={{ fontSize: 11 }}> · {o.slug}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
