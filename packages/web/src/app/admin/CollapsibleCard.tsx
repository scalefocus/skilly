"use client";
import type { ReactNode } from "react";

// Administration console: every card is a collapsible panel (SKILLY_SPEC.md §5). The header
// (title + optional compact live summary + optional accessory such as the SCIM pills) is always
// visible and toggles the body; the body animates open/closed via a CSS grid-rows transition
// (~200ms; instant under prefers-reduced-motion — see .admin-card-body in globals.css). The body
// stays MOUNTED while collapsed so each card's data/polling and in-progress state survive a
// collapse (answer 3c) — collapse hides, it never unmounts.
export function CollapsibleCard({
  cardId,
  title,
  summary,
  accessory,
  open,
  onToggle,
  children,
}: {
  cardId: string;
  title: string;
  summary?: ReactNode;
  accessory?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = `admin-card-${cardId}`;
  return (
    <section className="card reveal admin-card" style={{ marginBottom: 26 }}>
      <button
        type="button"
        className="admin-card-head"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <h2 className="admin-card-title">{title}</h2>
        {summary != null && <span className="admin-card-summary muted mono">{summary}</span>}
        {accessory != null && <span className="admin-card-accessory">{accessory}</span>}
        <span style={{ flex: 1 }} />
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
          className="admin-card-chevron" data-open={open}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className="admin-card-body" data-open={open} id={bodyId} role="region" aria-hidden={!open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">{children}</div>
        </div>
      </div>
    </section>
  );
}
