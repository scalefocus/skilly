"use client";
import { useEffect, useState, type ReactNode } from "react";
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
 * header — `CATEGORY · 14 ▸` — above a **zero-height, `inert`** chip block: the chips stay MOUNTED
 * (content that isn't in the box has no height to animate) but are unreachable — not focusable,
 * not announced, not visible. Expand/collapse animates height + opacity over ~0.2s, the §5
 * admin-card mechanism; see .facet-row-chipbox in globals.css.
 *
 * `count` is the size of the whole visible category vocabulary, NOT the number of chips currently
 * matching other filters: it must not wobble as the user filters (the catalog's
 * /api/skills/facets is filter-independent; §26 makes the requests facets so too).
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
  // Transitions are armed only AFTER the first render, so only a user toggle animates (§10). Every
  // way the row can already be open at first paint — the stored preference, or the auto-expand
  // from a restored category filter — paints open with no slide, which matters because the whole
  // filter block arrives under a `.reveal` rise. A transition needs a *previous* computed value to
  // animate from, and the first render never has one; after it, `open` changes only by way of the
  // header (both callers set the open state in their prefs effect on *page* mount — a synchronous
  // localStorage read — while this row renders only once the facets fetch resolves).
  // Deliberately not requestAnimationFrame: rAF never fires in a background tab, which would leave
  // a row opened in an unfocused tab unarmed.
  const [animate, setAnimate] = useState(false);
  useEffect(() => { setAnimate(true); }, []);
  // The wrappers clip so the height transition looks right, but a permanent clip shaves the focus
  // ring off chips on the block's top and bottom edges. `settled` marks the block fully open and
  // the CSS then releases the clip; the timeout mirrors the 0.2s transition (and covers
  // prefers-reduced-motion, where no transitionend fires). Collapsing re-clips instantly.
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = setTimeout(() => setSettled(true), 220);
    return () => clearTimeout(t);
  }, [open]);
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
      <div
        className="facet-row-chipbox"
        id={chipsId}
        role="region"
        data-open={open}
        data-anim={animate}
        data-settled={settled}
        aria-hidden={!open}
        // `inert` is a boolean attribute — present at all means inert — so it is spread in only
        // while collapsed rather than passed as `inert={!open}`.
        {...(open ? {} : { inert: true })}
      >
        <div className="facet-row-chipbox-inner">
          <div className="facet-row-chips">{children}</div>
        </div>
      </div>
    </div>
  );
}
