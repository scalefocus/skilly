"use client";
import { useId, useState } from "react";
import type { UpcomingEntry } from "./upcoming";

/** The greyed-out "Coming soon" section above the release list (SKILLY_SPEC.md §23 "Coming soon").
 *  `entries` is already audience-filtered. Collapsed on every visit — the open state is never
 *  stored — and the list is not rendered while collapsed. Hidden when nothing applies. */
export function ComingSoon({ entries }: { entries: UpcomingEntry[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (entries.length === 0) return null;
  return (
    <section className="coming-soon" data-testid="coming-soon">
      <button
        type="button"
        className="coming-soon-head"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="coming-soon-glyph">
          <circle cx="12" cy="12" r="10" />
          <path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
        </svg>
        <span className="coming-soon-text">
          <span className="coming-soon-title">Coming soon · {entries.length}</span>
          <span className="muted coming-soon-sub">Planned and specified, not available yet. Plans can change.</span>
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul id={listId} aria-label="Coming soon" className="coming-soon-list">
          {entries.map((e) => (
            <li key={e.ids.join(",")} className="coming-soon-row">
              <span className="chip" style={{ fontSize: 12 }}>Coming soon</span>
              <div className="coming-soon-row-title">{e.title}</div>
              <p className="coming-soon-row-teaser">{e.teaser}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
