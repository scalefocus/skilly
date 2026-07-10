"use client";
import { type CSSProperties, useState } from "react";
import { Markdown } from "./Markdown";

/**
 * Editable Markdown field with a Write/Preview toggle (used for skill description & usage in
 * the propose form and the reviewer-edit form). Write shows the raw textarea; Preview renders
 * the same Markdown the detail page will show. When `disabled` (a locked field, e.g. a
 * skill-level field while proposing a NEW VERSION) there's nothing to edit, so it just renders
 * the Markdown read-only — no toggle.
 */
export function MarkdownField({
  value,
  onChange,
  rows = 3,
  placeholder,
  disabled = false,
  mono = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  style?: CSSProperties;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");

  if (disabled) {
    return (
      <div className="md-field-preview">
        {value.trim() ? <Markdown source={value} /> : <span className="muted" style={{ fontSize: 13 }}>—</span>}
      </div>
    );
  }

  return (
    <div>
      <div className="sort-toggle" role="group" aria-label="Edit or preview" style={{ marginBottom: 8 }}>
        <button type="button" className={`sort-opt${tab === "write" ? " sort-on" : ""}`} onClick={() => setTab("write")}>
          ✎ Write
        </button>
        <button type="button" className={`sort-opt${tab === "preview" ? " sort-on" : ""}`} onClick={() => setTab("preview")}>
          ◹ Preview
        </button>
      </div>
      {tab === "write" ? (
        <textarea
          style={{ ...style, resize: "vertical", ...(mono ? { fontFamily: "var(--font-mono)", fontSize: 13 } : {}) }}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="md-field-preview" style={{ minHeight: rows * 24 + 20 }}>
          {value.trim() ? <Markdown source={value} /> : <span className="muted" style={{ fontSize: 13 }}>Nothing to preview yet.</span>}
        </div>
      )}
    </div>
  );
}
