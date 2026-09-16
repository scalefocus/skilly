"use client";
// Real-user-monitoring collector (SKILLY_SPEC.md §32.4). Mounted once in the app shell for a
// signed-in user; renders nothing. Collects page views, route-transition time, Web Vitals (via the
// `web-vitals` package — a build-time dependency, no CDN), browser-observed `/api/*` latency, and
// client errors, then batches them to `POST /api/rum` (≤ 50 per batch, every 10 s, and on
// hide/pagehide via sendBeacon). Every sample carries a ROUTE TEMPLATE, never a concrete path.
//
// The collector is fail-silent by design: a rejected batch is dropped (no retry), nothing here can
// throw into the app, and it never blocks the UI. Collection is gated by the platform flag
// (`rumEnabled`) and a once-per-session sampling draw (`rumSampleRate`), both read from /api/me on
// mount and re-read every 60 s so flipping the switch stops collection within a minute.
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { onCLS, onINP, onLCP, onTTFB } from "web-vitals/attribution";
import { templateForApiUrl, templateForPath } from "../lib/rum/routes";
import { fingerprintFor, RUM_MAX_BATCH, RUM_MAX_CLS, RUM_MAX_DURATION_MS, RUM_MAX_MESSAGE, sanitizeFrame, scrubMessage, type RumSampleIn } from "../lib/rum/validate";
import { cachedGet } from "./ui";

const SESSION_KEY = "skilly.rum.session";
const FLUSH_MS = 10_000;
const FLAGS_POLL_MS = 60_000;
/** Cap on samples held before the flags are known (or between flushes). Oldest are dropped. */
const BUFFER_CAP = 200;

// ---- module state: exactly one collector per tab -------------------------------------------------

interface SessionState {
  id: string;
  sampled: boolean;
}

let session: SessionState | null = null;
/** null = flags not loaded yet (buffer, don't flush); false = off (drop); true = collecting. */
let active: boolean | null = null;
let buffer: Omit<RumSampleIn, "sessionId">[] = [];
let currentRoute = "other";
const routeHistory: { at: number; route: string }[] = [];
let navIntentAt: number | null = null;
let installed = false;

/** Called right before a programmatic in-app navigation so the transition time can be measured. */
export function markRumNavIntent(): void {
  navIntentAt = performance.now();
}

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
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
  session = { id: randomId(), sampled: Math.random() * 100 < sampleRate };
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

function applyFlags(j: { rumEnabled?: unknown; rumSampleRate?: unknown } | null): void {
  if (!j) return;
  const enabled = j.rumEnabled !== false;
  const rate = typeof j.rumSampleRate === "number" ? j.rumSampleRate : 100;
  const s = loadSession(rate);
  const next = enabled && s.sampled;
  active = next;
  if (!next) buffer = [];
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
  // client-side; /api/rum and /api/presence/page are excluded inside templateForApiUrl.
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

  // Flush cadence + unload paths.
  setInterval(() => flush(false), FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));

  // Flags: /api/me on mount (deduped with the shell's own request), then every 60 s while visible.
  cachedGet<{ rumEnabled?: unknown; rumSampleRate?: unknown }>("/api/me").then(applyFlags).catch(() => {});
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    fetch("/api/me")
      .then((r) => (r.ok ? (r.json() as Promise<{ rumEnabled?: unknown; rumSampleRate?: unknown }>) : null))
      .then(applyFlags)
      .catch(() => {});
  }, FLAGS_POLL_MS);
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
    } catch {
      /* never throw into the shell */
    }
  }, [pathname]);

  return null;
}
