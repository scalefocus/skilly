"use client";
// The floating "What's new" notice (§23). Split out of AppShell and loaded via next/dynamic so the
// changelog it excerpts is downloaded only when the notice is due.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { APP_VERSION } from "@skilly/shared/version";
import { selectWhatsNewExcerpt } from "@skilly/shared/whats-new";
import { CHANGELOG } from "../app/whats-new/changelog";

/** The floating "What's new in X" card (§23). Polite live region: it announces itself but never
 *  steals focus; the ✕ is a real button reached by Tab. Excerpt = changelog lines newer than the
 *  user's marker (cap 3, overflow folded into the link); a null marker shows only the running
 *  version's line. The card is height-capped (60vh, CSS) and the excerpt list is its only scrolling
 *  child: when the list actually overflows (measured, re-checked on resize) it gets a Tab stop and
 *  a name so keyboard users can scroll it; a list that fits has no Tab stop. */
export function UpdateNotice({ since, hidden, onClose, onFollow }: { since: string | null; hidden: boolean; onClose: () => void; onFollow: () => void }) {
  const { entries, overflow } = selectWhatsNewExcerpt(CHANGELOG, since, APP_VERSION);
  const listRef = useRef<HTMLUListElement>(null);
  const [listOverflows, setListOverflows] = useState(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setListOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden, entries.length]);
  return (
    <div className={`update-notice${hidden ? " update-notice-hidden" : ""}`} role="status" data-testid="whats-new-notice">
      <div className="update-notice-head">
        <h2 className="update-notice-title">
          What&rsquo;s new in <span className="chip chip-accent mono">v{APP_VERSION}</span>
        </h2>
        <button type="button" className="update-notice-close" aria-label="Dismiss" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" />
          </svg>
        </button>
      </div>
      {entries.length > 0 && (
        <ul
          ref={listRef}
          className="update-notice-list"
          data-testid="whats-new-notice-excerpt"
          tabIndex={listOverflows ? 0 : undefined}
          aria-label={listOverflows ? "Release notes" : undefined}
        >
          {entries.map((e) => (
            <li key={e.version}>{e.summary}</li>
          ))}
        </ul>
      )}
      <Link
        href={since ? `/whats-new?since=${encodeURIComponent(since)}` : "/whats-new"}
        className="update-notice-link"
        onClick={onFollow}
      >
        See what&rsquo;s new{overflow > 0 ? ` (+${overflow} more)` : ""}
      </Link>
    </div>
  );
}
