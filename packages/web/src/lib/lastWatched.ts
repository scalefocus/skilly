// The pure rules behind the "last-watched card" behavior on the Administration console (§5) and
// the Namespace administration page (§30.6): which gestures set or clear the remembered card, and
// what a page does with it on arrival. DOM-free on purpose — the hook in useLastWatched.ts feeds
// these from the browser, and the unit tests feed them directly.

/** What the remembered card should be after a collapsible card's header toggle (§5). Expanding
 *  is "watching", so it sets the key. Collapsing never counts — but collapsing the card that is
 *  currently remembered clears it, otherwise the next arrival would auto-expand it again against
 *  the admin's last explicit choice. */
export function afterToggle(stored: string | null, cardId: string, nowOpen: boolean): string | null {
  if (nowOpen) return cardId;
  return stored === cardId ? null : stored;
}

export interface ArrivalInput {
  /** The remembered id, or null when unset / unreadable. */
  stored: string | null;
  /** Ids of the cards actually rendered on this visit. */
  rendered: readonly string[];
  /** `location.hash` at the data gate — a non-empty hash means the browser's own anchor wins. */
  hash: string;
  /** `window.scrollY` at the data gate — anything but the top means the user already scrolled. */
  scrollY: number;
}

export type ArrivalPlan =
  | { kind: "none" } // nothing happens; the stored value is left alone
  | { kind: "clear" } // the stored id names no rendered card — drop it silently
  | { kind: "arrive"; id: string }; // expand (where applicable), scroll unless in view, flash

/** The arrival decision, minus the geometry (see `needsScroll`). Runs once per visit, right after
 *  the page's data gate resolves. */
export function planArrival(input: ArrivalInput): ArrivalPlan {
  if (!input.stored) return { kind: "none" };
  if (input.hash && input.hash !== "#") return { kind: "none" };
  if (input.scrollY > 0) return { kind: "none" };
  if (!input.rendered.includes(input.stored)) return { kind: "clear" };
  return { kind: "arrive", id: input.stored };
}

/** Whether the scroll motion is needed: the card's header must be fully inside the viewport for
 *  the motion to be dropped (the expand + flash still run — the page never jumps for no reason). */
export function needsScroll(header: { top: number; bottom: number }, viewportHeight: number): boolean {
  return !(header.top >= 0 && header.bottom <= viewportHeight);
}
