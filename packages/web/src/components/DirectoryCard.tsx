"use client";
// Directory hover card (SKILLY_SPEC.md §28). Hover — or long-press on touch, or focus by keyboard —
// any avatar bubble and this floating card shows that person's Entra directory profile: job title,
// department and office, alongside their name, email and online dot.
//
// The whole trigger side lives in `useDirectoryCard`, which `UserBubble` spreads onto whatever
// element it renders (photo or initials), so every avatar in the app gets the card at once.
// Data is fetched lazily at the same hover-intent threshold that opens the card — a page with a
// hundred bubbles issues zero requests until someone actually hovers one.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cachedGet } from "./ui";
import { BADGE_META, badgeLabel, type LeaderBadgeInfo } from "./leaderBadges";

/** `GET /api/users/:id/card`. Badges are NOT here — they come from the `/api/leaders` map the
 *  bubble already holds (§28). */
export interface UserCardData {
  userId: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  officeLocation: string | null;
  department: string | null;
  lastSeen: string | null;
  online: boolean;
}

const OPEN_DELAY_MS = 300; // hover intent — a pointer crossing a dense table must not fire cards
const CLOSE_DELAY_MS = 150; // grace period so the pointer can travel into the card (mailto link)
const LONG_PRESS_MS = 500;
const MOVE_ABORT_PX = 10; // a press that travels this far is a scroll, not a long-press
const GAP_PX = 8;
const CARD_WIDTH = 260;

// Survives for the page session so a re-hover paints instantly with no loading flicker; the
// refresh behind it still runs through `cachedGet`, which dedupes concurrent bubbles of the same
// person onto one request.
const cardCache = new Map<string, UserCardData>();

// Only one card is ever open (§28) — opening a second closes the first.
let activeClose: (() => void) | null = null;

/** Relative "active …" for the presence line. Unlike the admin online list (capped at hours by its
 *  window), a card can show someone last seen days or weeks ago. */
function activeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "active just now";
  if (s < 3600) return `active ${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `active ${Math.floor(s / 3600)}h ago`;
  return `active ${Math.floor(s / 86_400)}d ago`;
}

export function useDirectoryCard(userId: string | null | undefined, name: string, badges: LeaderBadgeInfo[]) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<UserCardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const openRef = useRef(false);
  const closeRef = useRef<() => void>(() => {});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (activeClose === closeRef.current) activeClose = null;
    };
  }, []);

  const clearTimer = (t: React.MutableRefObject<number | null>) => {
    if (t.current !== null) {
      window.clearTimeout(t.current);
      t.current = null;
    }
  };

  const close = useCallback(() => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
    clearTimer(pressTimer);
    openRef.current = false;
    setOpen(false);
    if (activeClose === closeRef.current) activeClose = null;
  }, []);
  closeRef.current = close;

  const doOpen = useCallback(() => {
    if (!userId) return;
    if (activeClose && activeClose !== closeRef.current) activeClose();
    activeClose = closeRef.current;
    const el = triggerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + GAP_PX }); // refined (clamped/flipped) once measured
    }
    openRef.current = true;
    setOpen(true);
    const cached = cardCache.get(userId);
    if (cached) {
      setData(cached);
      setFailed(false);
    }
    // Refresh even on a cache hit — presence goes stale fast. A failure only shows the
    // "no directory information" state when we have nothing cached to keep showing.
    void cachedGet<UserCardData>(`/api/users/${userId}/card`)
      .then((c) => {
        cardCache.set(userId, c);
        if (!alive.current) return;
        setData(c);
        setFailed(false);
      })
      .catch(() => {
        if (alive.current && !cardCache.has(userId)) setFailed(true);
      });
  }, [userId]);

  // Keep the card glued to its bubble: clamp inside the viewport and flip above when it would
  // overflow the bottom. Runs before paint, so there is no visible jump.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const card = cardRef.current;
    const el = triggerRef.current;
    if (!card || !el) return;
    const r = el.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + GAP_PX;
    if (left + cr.width > window.innerWidth - GAP_PX) left = window.innerWidth - GAP_PX - cr.width;
    if (left < GAP_PX) left = GAP_PX;
    if (top + cr.height > window.innerHeight - GAP_PX) {
      const above = r.top - GAP_PX - cr.height;
      top = above >= GAP_PX ? above : Math.max(GAP_PX, window.innerHeight - GAP_PX - cr.height);
    }
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [open, pos, data, failed, badges.length]);

  // While open: Escape closes (from anywhere, incl. focus inside the card), an outside press
  // dismisses, and scroll/resize dismisses rather than leaving the card stranded mid-air.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (cardRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  const scheduleClose = () => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
    closeTimer.current = window.setTimeout(close, CLOSE_DELAY_MS);
  };

  // A bubble with no user id (the rare payload that doesn't carry one) is inert: no tab stop, no
  // card, no request. It still gets the class + contextmenu guard, because the native long-press
  // callout is suppressed on ALL avatars app-wide, not just the ones that can open a card (§28).
  const interactive = !!userId;
  const triggerProps: React.HTMLAttributes<HTMLElement> & { ref: (el: HTMLElement | null) => void; className: string } = {
    className: "avatar-trigger",
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
    },
    tabIndex: interactive ? 0 : undefined,
    role: interactive ? "button" : undefined,
    "aria-haspopup": interactive ? "dialog" : undefined,
    "aria-expanded": interactive ? open : undefined,
    "aria-label": interactive ? `${name} — profile` : undefined,
    onPointerEnter: (e: React.PointerEvent) => {
      if (!interactive || e.pointerType !== "mouse") return;
      clearTimer(closeTimer);
      if (openRef.current) return;
      clearTimer(openTimer);
      openTimer.current = window.setTimeout(doOpen, OPEN_DELAY_MS);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (!interactive || e.pointerType !== "mouse") return;
      scheduleClose();
    },
    onPointerDown: (e: React.PointerEvent) => {
      suppressClick.current = false;
      if (!interactive || e.pointerType === "mouse") return;
      pressStart.current = { x: e.clientX, y: e.clientY };
      clearTimer(pressTimer);
      pressTimer.current = window.setTimeout(() => {
        pressStart.current = null;
        // The gesture is ours now: swallow the click this press would otherwise fire on release,
        // so long-pressing an avatar inside a row/link never navigates.
        suppressClick.current = true;
        if (openRef.current) close();
        else doOpen();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = pressStart.current;
      if (!s) return;
      if (Math.abs(e.clientX - s.x) > MOVE_ABORT_PX || Math.abs(e.clientY - s.y) > MOVE_ABORT_PX) {
        pressStart.current = null;
        clearTimer(pressTimer); // it's a scroll, not a press
      }
    },
    onPointerUp: () => {
      pressStart.current = null;
      clearTimer(pressTimer);
    },
    onPointerCancel: () => {
      pressStart.current = null;
      clearTimer(pressTimer);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onFocus: () => {
      if (!interactive) return;
      clearTimer(closeTimer);
      if (!openRef.current) doOpen(); // keyboard reach: no hover-intent delay
    },
    onBlur: (e: React.FocusEvent) => {
      // Tabbing INTO the card (the mailto link) must not close it.
      const next = e.relatedTarget as Node | null;
      if (next && cardRef.current?.contains(next)) return;
      close();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") close();
    },
  };

  const card =
    open && userId && pos
      ? createPortal(
          <div
            ref={cardRef}
            className="dircard"
            role="dialog"
            aria-label={`${data?.displayName ?? name} — profile`}
            style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }}
            onPointerEnter={() => clearTimer(closeTimer)}
            onPointerLeave={(e) => {
              if (e.pointerType !== "mouse") return;
              scheduleClose();
            }}
          >
            <DirectoryCardBody name={name} data={data} failed={failed} badges={badges} />
          </div>,
          document.body,
        )
      : null;

  return { triggerProps, card };
}

function DirectoryCardBody({
  name,
  data,
  failed,
  badges,
}: {
  name: string;
  data: UserCardData | null;
  failed: boolean;
  badges: LeaderBadgeInfo[];
}) {
  const lines = data
    ? ([
        ["Title", data.jobTitle],
        ["Department", data.department],
        ["Office", data.officeLocation],
      ] as const).filter(([, v]) => !!v)
    : [];

  return (
    <>
      <div className="dircard-name">{data?.displayName ?? name}</div>

      {data && (data.online || data.lastSeen) && (
        <div className="dircard-presence">
          <span className={`dircard-dot${data.online ? " dircard-dot-on" : ""}`} aria-hidden />
          <span>{data.online ? "Online" : activeAgo(data.lastSeen!)}</span>
        </div>
      )}

      {data?.email ? (
        <a className="dircard-mail mono" href={`mailto:${data.email}`}>
          {data.email}
        </a>
      ) : null}

      <div className="dircard-dir">
        {!data && !failed ? (
          <span className="muted">Loading…</span>
        ) : lines.length ? (
          lines.map(([label, value]) => (
            <div key={label} className="dircard-line">
              <span className="dircard-key">{label}</span>
              <span className="dircard-val">{value}</span>
            </div>
          ))
        ) : (
          // Nothing in Entra, opted out, an erased tombstone, or the fetch failed — one honest line.
          <span className="muted">No directory information</span>
        )}
      </div>

      {badges.length > 0 && (
        <div className="dircard-badges">
          {badges.map((b) => (
            <div key={`${b.metric}:${b.window}`} className="dircard-badge">
              <span aria-hidden style={{ background: BADGE_META[b.metric].color }} className="dircard-badge-dot">
                {BADGE_META[b.metric].icon}
              </span>
              <span>{badgeLabel(b)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
