"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Compact number formatting for display counts (15843 → "15.8K", 2_400_000 → "2.4M").
// Values under 1000 render verbatim. Used across overview/catalog/usage so large counts
// stay readable instead of overflowing.
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export function formatCount(n: number): string {
  return Number.isFinite(n) ? COMPACT.format(n) : String(n);
}

/** Copy a value to the clipboard, with a legacy fallback. Returns whether it succeeded. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copyable code, styled like a terminal line. The whole box is the click target and the `copy`
 *  pill is a visual affordance (`aria-hidden`), so there is no nested interactive. Confirmation is a
 *  centered toast portaled to <body>: the box scrolls horizontally on mobile, so in-box feedback at
 *  the right edge could sit off-screen.
 *
 *  - `prompt` (default true) draws the `$` terminal prompt — switch it off for anything that is not
 *    a shell command (§29's `mcp.json` snippet).
 *  - `pin` puts the pill INSIDE the box, anchored to the top-right, for a snippet that is too tall
 *    or too wide for an inline affordance (§29's connect snippets).
 *  - `autoCopy` copies whenever the command changes (a freshly minted install command) and shows the
 *    same toast — best-effort, since a post-fetch clipboard write may be blocked outside the click's
 *    activation; clicking the box always copies.
 *
 *  A click is ignored while the user has text selected, so dragging one line out of a multi-line
 *  snippet never silently replaces the clipboard with the whole thing. */
export function CopyCommand({
  command,
  autoCopy,
  prompt = true,
  pin,
  ariaLabel = "Copy install command",
}: {
  command: string;
  autoCopy?: boolean;
  prompt?: boolean;
  pin?: boolean;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  // Activation from a click or a keypress: bail out when the user is selecting text rather than
  // asking for the whole snippet. `copy()` itself stays unguarded, so autoCopy is unaffected by
  // whatever happens to be selected elsewhere on the page when a command is minted.
  const activate = () => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    void copy();
  };
  // Auto-copy a newly generated command (the install flow), surfacing the same toast.
  useEffect(() => {
    if (autoCopy && command) void copy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, autoCopy]);

  // The interactive attributes go on whichever element WRAPS both the code and the pill, so that a
  // click on the pill counts too. Unpinned that is the .code row itself; pinned it is the outer
  // wrapper, since there the pill is a sibling of the scrolling box rather than a child of it.
  const interactive = {
    onClick: activate,
    role: "button",
    tabIndex: 0,
    title: "Click to copy",
    // An explicit name, or a screen reader reads the whole snippet as the button's label.
    "aria-label": ariaLabel,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    },
  } as const;
  const toast = copied && createPortal(<div className="toast" role="status">✓ Copied</div>, document.body);

  if (pin) {
    return (
      <>
        {/* `minWidth: 0` is load-bearing: this wrapper is a grid item, and the default
            `min-width: auto` would size it to the snippet's widest line — pushing the pill
            off-screen and scrolling the whole PAGE on a narrow viewport, instead of letting the
            box scroll inside itself. */}
        <div {...interactive} style={{ position: "relative", minWidth: 0, cursor: "pointer" }}>
          <div
            className="code"
            // `display:block` overrides .code's flex: Chromium cannot drag-select text inside a flex
            // container, and a snippet a user cannot partially select is a step back from the plain
            // <pre> this replaces. Nothing needs flex here — the pill is positioned. The right-hand
            // reserve keeps characters from ending up underneath it.
            style={{ display: "block", paddingRight: 76 }}
          >
            {prompt && <span className="prompt">$</span>}
            <code className="code-cmd">{command}</code>
          </div>
          {/* Anchored to the wrapper, not to the scrolling box, so it never scrolls out of view. The
              band runs to the box's edge in the box's own colour, so a long line scrolling past does
              not leave a sliver of text stranded beside the pill. */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 1,
              right: 1,
              display: "flex",
              padding: "7px 7px 7px 10px",
              background: "var(--surface-2, rgba(127,127,127,.08))",
              borderRadius: "0 var(--radius-sm) 0 var(--radius-sm)",
            }}
          >
            <span className="btn btn-sm">copy</span>
          </span>
        </div>
        {toast}
      </>
    );
  }
  return (
    <>
      <div {...interactive} className="code" style={{ cursor: "pointer" }}>
        {prompt && <span className="prompt">$</span>}
        <code className="code-cmd">{command}</code>
        <span className="btn btn-sm" style={{ marginLeft: "auto" }} aria-hidden>
          copy
        </span>
      </div>
      {toast}
    </>
  );
}

/**
 * "Share" button: copies the current page URL (or an explicit `url`) and confirms with a
 * centered toast. Styled like the other `btn btn-sm` actions so it sits naturally beside them.
 */
export function ShareButton({ url, label = "Share", title = "Copy a link to this skill" }: { url?: string; label?: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const target = url ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!target) return;
    if (await copyToClipboard(target)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <button type="button" className="btn btn-sm" onClick={share} title={title}>
      <span aria-hidden style={{ marginRight: 5 }}>↗</span>{label}
      {copied && createPortal(<div className="toast" role="status">✓ Link copied</div>, document.body)}
    </button>
  );
}

const PILL_CLASS: Record<string, string> = {
  ok: "pill pill-ok",
  warn: "pill pill-warn",
  danger: "pill pill-danger",
  muted: "pill pill-muted",
  accent: "pill pill-accent",
};
export function Pill({ tone = "muted", children }: { tone?: "ok" | "warn" | "danger" | "muted" | "accent"; children: React.ReactNode }) {
  return <span className={PILL_CLASS[tone]}>{children}</span>;
}

// Shared client-side cache for GET JSON: dedupes concurrent identical requests and serves a
// fresh-enough cached body to components that mount close together (e.g. several widgets all
// reading /api/me on one page) or across a quick navigation — instead of every caller firing
// its own request. Short TTL keeps it from masking real updates; `reload()` always refetches.
const API_TTL_MS = 5_000;
const apiCache = new Map<string, { data: unknown; ts: number }>();
const apiInflight = new Map<string, Promise<unknown>>();

async function fetchJson(url: string, force: boolean): Promise<unknown> {
  if (force) {
    apiCache.delete(url);
    apiInflight.delete(url);
  } else {
    const cached = apiCache.get(url);
    if (cached && Date.now() - cached.ts < API_TTL_MS) return cached.data;
    const flight = apiInflight.get(url);
    if (flight) return flight;
  }
  const p = fetch(url)
    .then(async (r) => {
      if (r.status === 401) throw new Error("Sign in to view the registry.");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      return r.json();
    })
    .then((j) => {
      apiCache.set(url, { data: j, ts: Date.now() });
      return j;
    })
    .finally(() => {
      if (apiInflight.get(url) === p) apiInflight.delete(url);
    });
  apiInflight.set(url, p);
  return p;
}

/** Invalidate a cached GET (call after a mutation that changes what `url` would return). */
export function invalidateApi(url: string): void {
  apiCache.delete(url);
  apiInflight.delete(url);
}

/** Shared cached GET for non-hook callers (providers, effects) — same dedupe/cache as useApi. */
export function cachedGet<T>(url: string): Promise<T> {
  return fetchJson(url, false) as Promise<T>;
}

/**
 * Fetch a URL that returns a downloadable file (e.g. a CSV export), trigger the browser's native
 * save dialog for it via a throwaway blob-URL anchor, and return the export's X-Total-Matching /
 * X-Exported-Count response headers so the caller can warn when a capped export was truncated
 * (exported < total). Filename comes from the response's Content-Disposition.
 */
export async function downloadFile(url: string): Promise<{ total: number; exported: number }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
  const blob = await r.blob();
  const filename = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const total = Number(r.headers.get("x-total-matching") ?? "0");
  const exported = Number(r.headers.get("x-exported-count") ?? "0");
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
  return { total, exported };
}

/**
 * Page-level Enter shortcut: fires `handler` when the user presses Enter while NOT typing in a
 * field or focused on a button/link (so it never hijacks form submits, search, or activation).
 * Used for the per-page "press Enter to…" affordances.
 */
export function useEnterKey(handler: () => void, enabled = true): void {
  const cb = useRef(handler);
  cb.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A" || t?.isContentEditable) return;
      e.preventDefault();
      cb.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * Keeps a popover mounted for `duration` ms after `open` goes false, so its CSS close animation
 * (the shared `.menu-pop` classes in globals.css) can play instead of the panel vanishing
 * instantly. Returns null while closed, "open" while opening/open, "closing" during the exit.
 */
export function usePopoverPresence(open: boolean, duration = 160): "open" | "closing" | null {
  const [state, setState] = useState<"open" | "closing" | null>(open ? "open" : null);
  useEffect(() => {
    if (open) {
      setState("open");
      return;
    }
    setState((s) => (s === null ? null : "closing"));
    const t = setTimeout(() => setState(null), duration);
    return () => clearTimeout(t);
  }, [open, duration]);
  return state;
}

/** Tiny JSON fetch hook with loading / error / 401 awareness, backed by a shared cache. */
export function useApi<T>(url: string | null): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setLoading(true);
    setError(null);
    // tick > 0 means an explicit reload() — bypass the cache and refetch.
    fetchJson(url, tick > 0)
      .then((j) => live && setData(j as T))
      .catch((e) => live && setError(String((e as Error).message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [url, tick]);

  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

/**
 * Infinite-scroll sentinel: invisible row that calls onLoadMore when it scrolls into view.
 * Render it after the list while hasMore; the parent owns offset/accumulation state.
 */
export function LoadMoreSentinel({ onLoadMore, hasMore, loading }: { onLoadMore: () => void; hasMore: boolean; loading: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Keep the latest callback without re-creating the observer per render.
  const cb = useRef(onLoadMore);
  cb.current = onLoadMore;
  const armed = hasMore && !loading;

  useEffect(() => {
    const el = ref.current;
    if (!el || !armed) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) cb.current();
    }, { rootMargin: "320px" }); // prefetch before the user actually hits the bottom
    obs.observe(el);
    return () => obs.disconnect();
  }, [armed]);

  if (!hasMore) return null;
  return (
    <div ref={ref} style={{ padding: "14px 0", textAlign: "center" }} aria-hidden>
      <span className="muted mono" style={{ fontSize: 11 }}>{loading ? "loading more…" : "·"}</span>
    </div>
  );
}

/**
 * Floating "back to top" affordance: fades/slides in once the user scrolls past `threshold`,
 * and returns to the top with an animated (smooth) scroll.
 */
export function ScrollToTop({ threshold = 400 }: { threshold?: number }) {
  const [visible, setVisible] = useState(false);
  // Portal target — only set after mount (no document during SSR).
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => setBody(document.body), []);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  // Portaled to <body>: ancestors with transform animations (e.g. .reveal's entry rise,
  // which fills forwards) create a containing block that demotes position:fixed to
  // absolute — the button would sit at the page bottom and scroll with it.
  if (!body) return null;
  return createPortal(
    <button
      type="button"
      aria-label="Scroll back to top"
      title="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
      style={{
        position: "fixed",
        right: 26,
        bottom: 26,
        zIndex: 60,
        width: 42,
        height: 42,
        borderRadius: "50%",
        border: "1px solid var(--line)",
        background: "var(--surface)",
        color: "var(--ink)",
        boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        // animated appearance; the return itself animates via behavior:"smooth"
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(14px)",
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity 180ms ease, transform 220ms ease",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 19V5" />
        <path d="m5 12 7-7 7 7" />
      </svg>
    </button>,
    body
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="card-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card skill-card">
          <div className="skeleton" style={{ height: 22, width: "70%" }} />
          <div className="skeleton" style={{ height: 13, width: "100%" }} />
          <div className="skeleton" style={{ height: 13, width: "85%" }} />
          <div className="skeleton" style={{ height: 22, width: "45%", marginTop: 6 }} />
        </div>
      ))}
    </div>
  );
}

/**
 * §29 attribution: content an AGENT created on a user's behalf is marked wherever a human reads
 * it — a proposal header and review-queue row, a message bubble, a request card, a rating. The
 * acting user is still the person; this says how the act ARRIVED, not who is responsible.
 * Renders nothing when `client` is null/absent, so callers can drop it in unconditionally.
 */
export function ViaMcp({ client, align = "left" }: { client?: string | null; align?: "left" | "right" }) {
  if (!client) return null;
  return (
    <span
      className="muted mono"
      title={`Submitted through the MCP server by ${client}, acting for this user`}
      style={{ fontSize: 10, letterSpacing: 0.3, whiteSpace: "nowrap", textAlign: align }}
    >
      via MCP · {client}
    </span>
  );
}

export function EmptyState({ icon = "✦", title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="ico">{icon}</div>
      <div style={{ fontWeight: 500, color: "var(--ink)", fontSize: 16 }}>{title}</div>
      {hint && <div style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}
