"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
// Subpath import: the root barrel pulls node:crypto (tokens.ts), which can't ship to the client.
import { normalizeReviewTarget, reviewTargetError } from "@skilly/shared/review-target";

/**
 * A namespace's review target and its live proposal counts (SKILLY_SPEC.md §65.7, §75.4).
 *
 * ONE component serves both surfaces — the Namespace administration page (`/namespaces`) and the
 * platform Administration → Namespaces card — so they cannot drift on validation, help text or the
 * count links. Only the label placement differs, exactly as for the maintainer contact (§30.6): a
 * form-style card stacks an uppercase-mono micro-label above the field, while a settings row keeps
 * the inline label its sibling rows use.
 *
 * The target is empty (none) or 1–30 business days — the shared validator the server runs too.
 * Each count links to the To review queue narrowed to this namespace.
 */
export function ReviewTargetField({
  slug,
  value,
  counts,
  onSave,
  busy = false,
  layout,
  labelStyle,
  confirmSaved = false,
}: {
  /** The namespace's slug — the count links narrow the queue with it. */
  slug: string;
  /** The saved target in business days, or null for none. */
  value: number | null;
  /** §65.7 live counts: open, open with no assignee, and reviewer-turn proposals past due. */
  counts: { open: number; unassigned: number; overdue: number };
  /** Persist the target (`null` clears it). Resolves true on success. */
  onSave: (days: number | null) => Promise<boolean>;
  busy?: boolean;
  /** `stacked` = micro-label above (form-style cards); `inline` = label beside (settings rows). */
  layout: "stacked" | "inline";
  /** The surface's own micro-label style, so a stacked field matches its neighbours exactly. */
  labelStyle?: React.CSSProperties;
  /** Show *Review target saved.* beside Save — for a surface with no message line of its own. */
  confirmSaved?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value == null ? "" : String(value));
  const [saved, setSaved] = useState(false);
  // Keep the field authoritative to the saved value once a save (and reload) lands.
  useEffect(() => { setText(value == null ? "" : String(value)); }, [value]);

  const error = reviewTargetError(text);
  const dirty = !error && normalizeReviewTarget(text) !== value;
  const q = (extra: string) => `/proposals?tab=review&ns=${encodeURIComponent(slug)}${extra}`;

  const save = async () => {
    if (busy || !dirty) return;
    setSaved(false);
    if (await onSave(normalizeReviewTarget(text))) setSaved(true);
  };

  const control = (
    <>
      <input
        id={id}
        className="input"
        type="number"
        min={1}
        max={30}
        step={1}
        inputMode="numeric"
        placeholder="none"
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) { e.preventDefault(); void save(); } }}
        aria-describedby={`${id}-help`}
        aria-invalid={!!error}
        style={{ width: 90 }}
        data-testid="ns-review-target-input"
      />
      <span className="muted" style={{ fontSize: 12.5 }}>business days</span>
      <button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => void save()} data-testid="ns-review-target-save">
        Save
      </button>
      {confirmSaved && saved && (
        <span role="status" style={{ fontSize: 12.5, color: "var(--ok)", whiteSpace: "nowrap" }} data-testid="ns-review-target-saved">
          Review target saved.
        </span>
      )}
    </>
  );

  const below = (
    <>
      <div id={`${id}-help`} className="muted" style={{ fontSize: 12, marginTop: 5 }}>
        Proposals waiting longer than this remind their reviewer. Leave empty for no target.
      </div>
      {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 4 }}>{error}</div>}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }} data-testid="ns-review-counts">
        <Link href={q("")}>{counts.open} open</Link>
        {" · "}
        <Link href={q("&assignee=none")}>{counts.unassigned} unassigned</Link>
        {value != null && (
          <>
            {" · "}
            <Link href={q("&overdue=1")} style={counts.overdue > 0 ? { color: "var(--danger)" } : undefined}>{counts.overdue} overdue</Link>
          </>
        )}
      </div>
    </>
  );

  if (layout === "stacked") {
    return (
      <div style={{ marginTop: 14 }} data-testid="ns-review-target">
        <label htmlFor={id} style={labelStyle}>Review target</label>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>{control}</div>
        {below}
      </div>
    );
  }

  return (
    <div data-testid="ns-review-target">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label htmlFor={id} style={{ fontSize: 13.5 }}>Review target</label>
        {control}
      </div>
      {below}
    </div>
  );
}
