"use client";
// Real-user-monitoring collector (SKILLY_SPEC.md §32.4). Mounted once in the app shell for a
// signed-in user; renders nothing. Collects page views, route-transition time, Web Vitals (via the
// `web-vitals` package — a build-time dependency, no CDN), browser-observed `/api/*` latency, and
// client errors, then batches them to `POST /api/rum` (≤ 50 per batch) on a FLUSH LADDER and on
// hide/pagehide via sendBeacon. Every sample carries a ROUTE TEMPLATE, never a concrete path.
//
// The flush ladder (§32.4, lib/rum/ladder.ts): the timer walks the admin-configured interval set
// `rumFlushIntervals` (default primes, 17 s floor). A tick flushes only if the buffer holds anything,
// then — if no user action happened since the previous tick — climbs one step, holding at the last
// value; a pointerdown, keydown or route change snaps it back to the floor (pulling a pending tick
// forward to at most one floor from now, never closer). Hidden tabs freeze the timer; becoming
// visible restarts at the floor. The flags (`rumEnabled`, `rumSampleRate`, `rumFlushIntervals`) are
// read from /api/me on mount and re-read on a tick once 60 s have passed — there is no separate
// periodic poll, so an idle tab makes no request beyond its backed-off ticks.
//
// The collector is fail-silent by design: a rejected batch is dropped (no retry), nothing here can
// throw into the app, and it never blocks the UI. Collection is gated by the platform flag
// (`rumEnabled`) and a once-per-session sampling draw (`rumSampleRate`).
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { onCLS, onINP, onLCP, onTTFB } from "web-vitals/attribution";
import { templateForApiUrl, templateForPath } from "../lib/rum/routes";
import { fingerprintFor, RUM_MAX_BATCH, RUM_MAX_CLS, RUM_MAX_DURATION_MS, RUM_MAX_MESSAGE, sanitizeFrame, scrubMessage, type RumSampleIn } from "../lib/rum/validate";
import { DEFAULT_RUM_FLUSH_INTERVALS, RUM_FLAGS_REREAD_MS, clampIndex, delayMs, isValidFlushSet, nextIndex, snappedDelayMs } from "../lib/rum/ladder";
import { cachedGet } from "./ui";

const SESSION_KEY = "skilly.rum.session";
/** Cap on samples held before the flags are known (or between flushes). Oldest are dropped. */
const BUFFER_CAP = 200;

// ---- module state: exactly one collector per tab -------------------------------------------------

interface SessionState {
  id: string;
  sampled: boolean;
}

interface Flags {
  rumEnabled?: unknown;
  rumSampleRate?: unknown;
  rumFlushIntervals?: unknown;
}

let session: SessionState | null = null;
/** null = flags not loaded yet (buffer, don't flush); false = off (drop); true = collecting. */
let active: boolean | null = null;
let buffer: Omit<RumSampleIn, "sessionId">[] = [];
let currentRoute = "other";
const routeHistory: { at: number; route: string }[] = [];
let navIntentAt: number | null = null;
let installed = false;

// The flush ladder (§32.4).
let flushSet: readonly number[] = DEFAULT_RUM_FLUSH_INTERVALS;
let ladderIndex = 0;
let actedSinceTick = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDueAt = 0;
let lastFlagsReadAt = 0;

/** Called right before a programmatic in-app navigation so the transition time can be measured. */
export function markRumNavIntent(): void {
  navIntentAt = performance.now();
}

/** A uniform random number in [0, 1) from the Web Crypto CSPRNG. The id below is an opaque
 *  per-tab correlation handle rather than a credential, but a guessable draw is still nothing to
 *  hand out — and it keeps the sampling decision unbiased. Throws when Web Crypto is unavailable. */
function secureRandom01(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/** The per-tab session (sessionStorage, dies with the tab). The sampling draw is made ONCE, when the
 *  id is created, so a session is either fully sampled or fully silent. */
function loadSession(sampleRate: number): SessionState {
  if (session) return session;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<SessionState>;
      if (typeof j.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(j.id) && typeof j.sampled === "boolean") {
        session = { id: j.id, sampled: j.sampled };
        return session;
      }
    }
  } catch {
    /* storage unavailable — fall through to an in-memory session */
  }
  try {
    session = { id: randomId(), sampled: secureRandom01() * 100 < sampleRate };
  } catch {
    // No Web Crypto at all (never in a supported browser): stay silent rather than guess.
    session = { id: `nocrypto-${Date.now().toString(36)}`, sampled: false };
  }
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* in-memory only */
  }
  return session;
}

function push(sample: Omit<RumSampleIn, "sessionId">): void {
  if (active === false) return;
  buffer.push(sample);
  if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP);
}

function flush(unloading: boolean): void {
  if (active !== true || !session || buffer.length === 0) return;
  const sid = session.id;
  while (buffer.length) {
    const batch = buffer.splice(0, RUM_MAX_BATCH).map((s) => ({ ...s, sessionId: sid }));
    const body = JSON.stringify({ samples: batch });
    try {
      if (unloading && typeof navigator.sendBeacon === "function") {
        if (navigator.sendBeacon("/api/rum", new Blob([body], { type: "application/json" }))) continue;
      }
      fetch("/api/rum", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch {
      /* dropped */
    }
  }
}

// ---- the flush ladder -------------------------------------------------------------------------------

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timerDueAt = Date.now() + ms;
  timer = setTimeout(tick, ms);
}

/** Hidden tab: no ticks at all (the hide-flush has already emptied the buffer). */
function freeze(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function tick(): void {
  timer = null;
  if (document.visibilityState === "hidden") return; // frozen; the visibility handler restarts it
  try {
    flush(false);
    if (Date.now() - lastFlagsReadAt >= RUM_FLAGS_REREAD_MS) void readFlags(false);
  } catch {
    /* never let a flush kill the timer chain */
  }
  ladderIndex = nextIndex(ladderIndex, flushSet.length, actedSinceTick);
  actedSinceTick = false;
  schedule(delayMs(flushSet, ladderIndex));
}

/** A genuine user action: snap to the floor and pull a far-away tick forward to one floor from now.
 *  Never fires a flush by itself — the floor is the minimum spacing between beacons. */
function onUserAction(): void {
  actedSinceTick = true;
  ladderIndex = 0;
  if (!timer) return; // frozen (hidden) — the visibility handler restarts at the floor
  const remaining = timerDueAt - Date.now();
  const snapped = snappedDelayMs(remaining, flushSet);
  if (snapped < remaining) schedule(snapped);
}

function applyFlags(j: Flags | null): void {
  if (!j) return;
  const enabled = j.rumEnabled !== false;
  const rate = typeof j.rumSampleRate === "number" ? j.rumSampleRate : 100;
  if (isValidFlushSet(j.rumFlushIntervals)) {
    flushSet = j.rumFlushIntervals;
    ladderIndex = clampIndex(ladderIndex, flushSet.length);
  }
  const s = loadSession(rate);
  const next = enabled && s.sampled;
  active = next;
  if (!next) buffer = [];
}

/** Read the flags: deduped with the shell's own /api/me request on mount, a plain fetch on ticks. */
async function readFlags(initial: boolean): Promise<void> {
  lastFlagsReadAt = Date.now();
  try {
    const j = initial
      ? await cachedGet<Flags>("/api/me")
      : await fetch("/api/me").then((r) => (r.ok ? (r.json() as Promise<Flags>) : null));
    applyFlags(j);
  } catch {
    /* keep the current state; the next eligible tick tries again */
  }
}

/** The route that was current at `performance.now()`-time `t` (for INP attribution). */
function routeAt(t: number): string {
  let r = routeHistory[0]?.route ?? currentRoute;
  for (const h of routeHistory) {
    if (h.at <= t) r = h.route;
    else break;
  }
  return r;
}

function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim());
  const hit = lines.find((l) => /^at\s|:\d+:\d+\)?$|https?:\/\//.test(l) && l !== lines[0]) ?? "";
  return sanitizeFrame(hit);
}

async function reportError(type: string, rawMessage: string, rawFrame: string): Promise<void> {
  try {
    const route = currentRoute;
    const message = scrubMessage(rawMessage).slice(0, RUM_MAX_MESSAGE);
    const frame = sanitizeFrame(rawFrame);
    const fp = await fingerprintFor(type, message, frame);
    push({ kind: "error", route, name: fp, error: { type, message, frame } });
  } catch {
    /* never throw from the error handler */
  }
}

function installOnce(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    const landingRoute = () => routeHistory[0]?.route ?? currentRoute;
    // Web Vitals. LCP/TTFB are document-load metrics → the landing route. CLS/INP report every
    // change; each report is attributed to the route current when it happened (§32.1).
    onLCP((m) => push({ kind: "vital", route: landingRoute(), name: "lcp", value: Math.min(m.value, RUM_MAX_DURATION_MS) }));
    onTTFB((m) => push({ kind: "vital", route: landingRoute(), name: "ttfb", value: Math.min(m.value, RUM_MAX_DURATION_MS) }));
    onCLS((m) => {
      if (m.delta > 0) push({ kind: "vital", route: currentRoute, name: "cls", value: Math.min(m.delta, RUM_MAX_CLS) });
    }, { reportAllChanges: true });
    onINP((m) => {
      const t = m.attribution?.interactionTime;
      push({ kind: "vital", route: typeof t === "number" ? routeAt(t) : currentRoute, name: "inp", value: Math.min(m.value, RUM_MAX_DURATION_MS) });
    }, { reportAllChanges: true });
  } catch {
    /* vitals unsupported */
  }

  // Browser-observed API latency: same-origin /api/* fetch/XHR resource entries, templated
  // client-side; /api/rum and /api/presence/page are excluded inside templateForApiUrl. These are
  // NOT user actions (§32.4): a background poll must not keep the ladder at the floor.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (e.initiatorType !== "fetch" && e.initiatorType !== "xmlhttprequest") continue;
        const tpl = templateForApiUrl(e.name, location.origin);
        if (!tpl) continue;
        const status = (e as { responseStatus?: number }).responseStatus;
        push({ kind: "api", route: currentRoute, name: tpl, value: Math.min(Math.max(0, e.duration), RUM_MAX_DURATION_MS), ok: typeof status === "number" && status > 0 ? status < 400 : null });
      }
    });
    po.observe({ type: "resource", buffered: true });
  } catch {
    /* PerformanceObserver unsupported */
  }

  // Client errors (§32.2).
  window.addEventListener("error", (ev) => {
    if (!(ev instanceof ErrorEvent) || !ev.message) return; // resource-load errors carry no message
    const err = ev.error as { name?: string; stack?: string } | undefined;
    const frame = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : topFrame(err?.stack);
    void reportError(typeof err?.name === "string" && err.name ? err.name : "Error", ev.message, frame);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason as unknown;
    const isErr = r instanceof Error;
    void reportError(isErr ? r.name || "Error" : "UnhandledRejection", isErr ? r.message : String(r), topFrame(isErr ? r.stack : undefined));
  });

  // Navigation intent for the route-transition timer: internal, same-tab, unmodified left clicks.
  document.addEventListener(
    "click",
    (ev) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      navIntentAt = performance.now();
    },
    { capture: true },
  );

  // User actions that snap the ladder back to the floor (§32.4). Route changes are handled in the
  // pathname effect below. Scroll is deliberately not counted.
  document.addEventListener("pointerdown", onUserAction, { capture: true, passive: true });
  document.addEventListener("keydown", onUserAction, { capture: true, passive: true });

  // Unload paths + the hidden-tab freeze. Returning to the tab is an action: restart at the floor.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush(true);
      freeze();
    } else {
      ladderIndex = 0;
      actedSinceTick = false;
      schedule(delayMs(flushSet, 0));
    }
  });
  window.addEventListener("pagehide", () => flush(true));

  // Flags on mount (deduped with the shell's own request), then the first tick one floor from now.
  void readFlags(true);
  schedule(delayMs(flushSet, 0));
}

export function RumCollector() {
  const pathname = usePathname();

  useEffect(() => {
    installOnce();
  }, []);

  // Route changes: record the page view and, when an intent was captured, the transition time
  // measured to the new route's first paint (two animation frames after the pathname commit).
  useEffect(() => {
    try {
      const route = templateForPath(pathname);
      const now = performance.now();
      const isFirst = routeHistory.length === 0;
      routeHistory.push({ at: now, route });
      if (routeHistory.length > 500) routeHistory.splice(0, routeHistory.length - 500);
      currentRoute = route;
      push({ kind: "page_view", route });
      const intent = navIntentAt;
      navIntentAt = null;
      if (!isFirst && intent != null) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const dur = performance.now() - intent;
            if (dur >= 0 && dur <= RUM_MAX_DURATION_MS) push({ kind: "nav", route, value: dur });
          }),
        );
      }
      // A route change is a user action (§32.4): snap the flush ladder back to the floor.
      if (!isFirst) onUserAction();
    } catch {
      /* never throw into the shell */
    }
  }, [pathname]);

  return null;
}
