"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Last-watched card (§5): the page provides `watch` (any pointer press / keyboard focus inside a
// card BODY marks that card as watched — the header is deliberately outside, since collapsing
// never counts) and `flashId` (the card to ring briefly on arrival). Null = the feature is off,
// so the component still works stand-alone.
export const CardWatchContext = createContext<{ watch: (id: string) => void; flashId: string | null } | null>(null);

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
  // The body wrappers clip (overflow:hidden) so the grid-rows transition looks right, but a
  // permanent clip cuts off absolutely-positioned in-card dropdowns (the user search in Delete
  // User Info, tag/maintainer menus). `settled` marks a card as fully open — the CSS then
  // releases the clip. Timeout mirrors the 0.2s CSS transition; it also covers
  // prefers-reduced-motion, where no transitionend would fire. Collapse re-clips instantly.
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = setTimeout(() => setSettled(true), 220);
    return () => clearTimeout(t);
  }, [open]);
  const watchCtx = useContext(CardWatchContext);
  const onBodyInteract = watchCtx ? () => watchCtx.watch(cardId) : undefined;
  const flash = watchCtx?.flashId === cardId;
  return (
    <section className={`card reveal admin-card${flash ? " card-flash" : ""}`} style={{ marginBottom: 26 }} data-last-card={cardId}>
      <button
        type="button"
        className="admin-card-head"
        data-card-header
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
      {/* Body interaction = "watching" (§5): capture-phase so any control inside counts, pointer or
          keyboard (focus landing in the body). The collapsed body is aria-hidden + zero-height, so
          nothing in it can be pressed or focused while collapsed. */}
      <div
        className="admin-card-body" data-open={open} data-settled={settled} id={bodyId} role="region" aria-hidden={!open}
        onPointerDownCapture={onBodyInteract}
        onFocusCapture={onBodyInteract}
      >
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">{children}</div>
        </div>
      </div>
    </section>
  );
}
