"use client";
import { type ReactNode } from "react";
import { formatCount } from "./ui";

// Labelled facet rows for the catalog and Requested-skills filter blocks (SKILLY_SPEC.md §10/§26).
// Both pages lay their filters out as `<label column> <chips>` rows, so the label gutter is a
// single shared CSS width (--facet-label-w) and every row's chips start at the same x — see
// .facet-row in globals.css.

/** A plain labelled row (Harness / Source): the label is static, the chips are always visible. */
export function FacetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facet-row">
      <span className="nav-label facet-row-label">{label}</span>
      <div className="facet-row-chips">{children}</div>
    </div>
  );
}

/**
 * The Category row: collapsible, and its caller starts it collapsed (§10). Collapsed renders the
 * header ALONE — `CATEGORY · 14 ▸` — and the chips are removed from the DOM rather than hidden, so
 * they leave the tab order entirely. `count` is the size of the whole visible category vocabulary,
 * NOT the number of chips currently matching other filters: it must not wobble as the user filters
 * (the catalog's /api/skills/facets is filter-independent; §26 makes the requests facets so too).
 */
export function CollapsibleFacetRow({
  id,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const chipsId = `facet-row-${id}`;
  return (
    <div className="facet-row">
      <button
        type="button"
        className="facet-row-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={chipsId}
      >
        <span className="nav-label facet-row-label">{label}</span>
        <span className="facet-n">· {formatCount(count)}</span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
          className="facet-row-chevron" data-open={open}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      {open ? (
        <div className="facet-row-chips" id={chipsId}>{children}</div>
      ) : (
        // The controlled region must exist for aria-controls to resolve while collapsed.
        <div id={chipsId} hidden />
      )}
    </div>
  );
}
