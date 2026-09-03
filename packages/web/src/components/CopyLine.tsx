"use client";
// A labelled, copyable command line: label + small copy button above a wrapped <pre>. Used by the
// marketplace add-command panels (Marketplaces page and Namespace administration, §30.6) — a
// marketplace command carries a long token-in-URL that must wrap, so it is not the pinned
// one-line `CopyCommand` the skill install panel uses.
import { useState } from "react";

export function CopyLine({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>{label}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 6 }}>
        {value}
      </pre>
      {hint && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
