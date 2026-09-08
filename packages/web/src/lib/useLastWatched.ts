"use client";
// The browser half of the last-watched card behavior (§5 Administration, §30.6 Namespace
// administration). The rules live in lib/lastWatched.ts; this hook feeds them from the DOM and
// performs the arrival: optional expand callback, a single header-centered scroll (smooth, instant
// under prefers-reduced-motion), and a brief highlight flash on the card.
//
// Markup contract: the card element carries `data-last-card="<id>"`; the element to center carries
// `data-card-header` inside it (falls back to the card itself). The flash is the `.card-flash`
// class (globals.css), applied by the page while `flashId === id`.
import { useCallback, useEffect, useRef, useState } from "react";
import { readPref, removePref, writePref } from "./prefs";
import { needsScroll, planArrival } from "./lastWatched";

/** How long the flash class stays on the card — a touch longer than the 1.2s CSS ring so the
 *  animation always completes; under reduced motion this is how long the static ring shows. */
export const LAST_WATCHED_FLASH_MS = 1400;

export interface UseLastWatchedArgs {
  /** The page's localStorage key (PREF_ADMIN_LAST_CARD / PREF_NS_LAST_CARD). */
  key: string;
  /** True once the page's data gate has resolved and the cards are painted. The arrival runs on
   *  the first render where this is true, once per mount ("once per visit"). */
  ready: boolean;
  /** The ids rendered on this visit — a remembered id outside this list is cleared silently. */
  rendered: readonly string[];
  /** Called for the arriving card BEFORE the scroll (the Administration page expands it here). */
  onArrive?: (id: string) => void;
}

export function useLastWatched({ key, ready, rendered, onArrive }: UseLastWatchedArgs) {
  const [flashId, setFlashId] = useState<string | null>(null);
  const done = useRef(false);
  const onArriveRef = useRef(onArrive);
  onArriveRef.current = onArrive;
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;

  // Set / clear — which gestures do so is decided by the pages (lib/lastWatched.ts has the
  // header-toggle rule).
  const watch = useCallback((id: string) => writePref(key, id), [key]);
  const clear = useCallback(() => removePref(key), [key]);
  const read = useCallback((): string | null => readPref(key, "") || null, [key]);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const plan = planArrival({
      stored: readPref(key, "") || null,
      rendered: renderedRef.current,
      hash: window.location.hash,
      scrollY: window.scrollY,
    });
    if (plan.kind === "none") return;
    if (plan.kind === "clear") {
      removePref(key);
      return;
    }
    const id = plan.id;
    onArriveRef.current?.(id);
    // Scroll after the paint that reflects onArrive (the expand), so the header's measured
    // position is the one the admin will see. The body grows BELOW the header, so a header-
    // centered scroll needs no re-anchoring after the expand animation (§5, answer 9).
    // NB: in a background/hidden tab the frame callback waits until the tab is shown — the scroll
    // and flash then run when the admin actually looks. The flash-clear timer therefore starts
    // INSIDE the callback, or a background-opened tab would flash and never clear.
    let t: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`[data-last-card="${cssEscape(id)}"]`);
      if (!card) return;
      const header = card.querySelector<HTMLElement>("[data-card-header]") ?? card;
      const rect = header.getBoundingClientRect();
      if (needsScroll(rect, window.innerHeight)) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        header.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      }
      setFlashId(id);
      t = setTimeout(() => setFlashId(null), LAST_WATCHED_FLASH_MS + 100);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (t !== undefined) clearTimeout(t);
    };
  }, [ready, key]);

  return { watch, clear, read, flashId };
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
