"use client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useSession, signIn, signOut } from "next-auth/react";
// Subpath import: client-safe pure constant (the root barrel pulls node:crypto).
import { APP_VERSION } from "@skilly/shared/version";
import { ThemeToggle } from "./ThemeToggle";
import { MessagesMenu } from "./MessagesMenu";
import { UserBubble } from "./UserBubble";
import { cachedGet, usePopoverPresence, Pill } from "./ui";
import { PageLabelOverrideProvider } from "./PageLabelOverride";
import { resolveStaticPageLabel } from "../lib/pageLabel";

const NAV: { href: string; label: string; icon: string; badge?: "catalog" | "review" | "requests" }[] = [
  { href: "/", label: "Overview", icon: "M3 12 12 4l9 8M5 10v9h14v-9" },
  { href: "/catalog", label: "Catalog", icon: "M4 5h16M4 12h16M4 19h10", badge: "catalog" },
  { href: "/propose", label: "Propose a skill", icon: "M12 5v14M5 12h14" },
  { href: "/requests", label: "Requested skills", icon: "M12 17h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4", badge: "requests" },
  { href: "/proposals", label: "Review queue", icon: "M5 4h11l3 3v13H5zM9 12h6M9 16h6", badge: "review" },
  { href: "/leaderboard", label: "Leaderboard", icon: "M4 20h4v-7H4zM10 20h4V4h-4zM16 20h4v-10h-4z" },
];
const USAGE_NAV = { href: "/usage", label: "Usage", icon: "M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3" };
const AUDIT_NAV = { href: "/audit", label: "Audit log", icon: "M5 4h11l3 3v13H5zM8 11h8M8 15h5M8 7h4" };
const SYSLOG_NAV = { href: "/system-log", label: "System log", icon: "M4 5h16v14H4zM7 9h2M7 13h2M7 17h2M12 9h5M12 13h5" };
const ADMIN_NAV = { href: "/admin", label: "Administration", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" };

function Icon({ d }: { d: string }) {
  return (
    <svg className="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [q, setQ] = useState("");
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [canAudit, setCanAudit] = useState(false);
  const [canUsage, setCanUsage] = useState(false);
  // First-login onboarding: null = unknown (until /api/me resolves), false = never seen Quick
  // start (gate forces it), true = seen. Drives the redirect gate below.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [unread, setUnread] = useState(0);
  // "New since you last looked" counts for the Catalog / Review queue / Requested skills nav items.
  const [navBadges, setNavBadges] = useState<{ catalog: number; review: number; systemLog: number; requests: number }>({ catalog: 0, review: 0, systemLog: 0, requests: 0 });
  // The header system banner (§27) — a platform-admin-set, org-wide announcement pill. Piggybacks
  // the same poll as the nav badges below rather than a dedicated transport.
  const [systemBanner, setSystemBanner] = useState<{ message: string; expiresAt: string } | null>(null);
  // Mobile off-canvas nav (the sidebar is hidden ≤880px; the hamburger opens it).
  const [navOpen, setNavOpen] = useState(false);
  // Bottom-left account menu (Profile / Sign out).
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Keeps the menu mounted through its exit animation (SKILLY_SPEC.md §23, Account menu).
  const userMenuPresence = usePopoverPresence(userMenuOpen);
  const userFootRef = useRef<HTMLDivElement>(null);
  // Sidebar scroll affordance: when the nav is taller than the viewport, show a chevron hint
  // at the bottom so it's obvious there's more below (and hide it once scrolled to the end).
  const sidebarRef = useRef<HTMLElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  // Header search autocomplete: suggestions appear once 2+ chars are typed (debounced).
  const [suggestions, setSuggestions] = useState<{ namespaceSlug: string; skillSlug: string; title: string; official?: boolean }[]>([]);
  const [acOpen, setAcOpen] = useState(false);
  const [acHi, setAcHi] = useState(-1);
  // True while a suggest request is in flight — gates the "Nothing found" bubble so it only
  // appears AFTER a search returns empty, never mid-typing/loading.
  const [acLoading, setAcLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Which provider the sign-in button targets. Entra in production; the passwordless
  // "dev" provider locally (SKILLY_DEV_AUTH=1), since Entra isn't configured in dev.
  // Resolved from next-auth's public /api/auth/providers so the button always works.
  const [signInProvider, setSignInProvider] = useState("azure-ad");

  // Some pages turn the search box into a live FILTER of an on-page list rather than the registry
  // typeahead dropdown: the catalog grid (§10), the installed-skills list (§23), and the usage
  // dashboard (§21). In all of them, typing mirrors the query into ?q=, the box is seeded from ?q=
  // on arrival, and the dropdown is suppressed. They differ only in the char floor (installed
  // filters an already-loaded list client-side, so it engages from the 1st char; catalog and usage
  // query the server at 2+ chars) and the placeholder. Everywhere else the box is the registry
  // typeahead dropdown.
  const onCatalog = pathname === "/catalog";
  const onInstalled = pathname === "/installed";
  const onUsage = pathname === "/usage";
  const liveFilter = onCatalog || onInstalled || onUsage;

  // Debounced autocomplete (typeahead pages only): fire at 2+ chars (matches the server floor),
  // 200ms after the last keystroke, ignore stale responses. Reset cleanly below the threshold or on
  // any live-filter page (catalog/installed/usage), where the box filters an on-page list instead.
  useEffect(() => {
    const term = q.trim();
    if (status !== "authenticated" || liveFilter || term.length < 2) {
      setSuggestions([]);
      setAcOpen(false);
      setAcLoading(false);
      return;
    }
    let live = true;
    setAcLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/skills/suggest?q=${encodeURIComponent(term)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live) return;
          setSuggestions(j?.suggestions ?? []);
          setAcOpen(true); // open even when empty → the "Nothing found" bubble confirms the search ran
          setAcHi(-1);
          setAcLoading(false);
        })
        .catch(() => { if (live) setAcLoading(false); });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, status, liveFilter]);

  // Reset the search box on every navigation: when ARRIVING on a live-filter page (catalog,
  // installed, or usage), seed it from ?q= so it reflects the active filter (e.g. landing via the
  // dropdown's "see all" or Enter from another page); otherwise CLEAR it — so a query typed on one
  // page doesn't linger and pop the suggestions dropdown on the next. Keyed on pathname (not q), so
  // it never fires while you type or while the live-filter rewrites ?q= (pathname is unchanged).
  useEffect(() => {
    setAcOpen(false);
    setQ(liveFilter ? new URLSearchParams(window.location.search).get("q") ?? "" : "");
  }, [pathname, liveFilter]);

  // Live-filter → URL: debounce the typed query into ?q=, merging with any other params on the
  // current path so they aren't clobbered (the catalog's category/tool/etc.). router.replace keeps
  // it out of history (like adjusting any other filter) and targets the current pathname so it works
  // on every live-filter page. The char floor differs by page: the installed list filters
  // client-side over an already-loaded set, so it engages from the 1st char (§23); the catalog and
  // usage query the server at 2+ chars. Below the floor the q filter clears (full list).
  useEffect(() => {
    if (!liveFilter) return;
    const floor = onInstalled ? 1 : 2;
    const term = q.trim();
    const t = setTimeout(() => {
      const sp = new URLSearchParams(window.location.search);
      const next = term.length >= floor ? term : "";
      if ((sp.get("q") ?? "") === next) return; // no change → don't churn the URL
      if (next) sp.set("q", next);
      else sp.delete("q");
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, 250);
    return () => clearTimeout(t);
  }, [q, liveFilter, onInstalled, pathname, router]);

  // Ctrl/Cmd+K focuses the registry search (only while signed in, since the box only
  // exists then). The kbd hint next to the box advertises the shortcut.
  useEffect(() => {
    if (status !== "authenticated") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  // Pages can ask the header search to take focus (e.g. the catalog's "press Enter to search").
  useEffect(() => {
    const focusSearch = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("skilly:focus-search", focusSearch);
    return () => window.removeEventListener("skilly:focus-search", focusSearch);
  }, []);

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (p?.dev) setSignInProvider("dev");
        else if (p?.["azure-ad"]) setSignInProvider("azure-ad");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    cachedGet<{ userId?: string | null; isPlatformAdmin?: boolean; maintainsSkills?: boolean; namespaceRoles?: { role: string }[]; onboardedAt?: string | null }>("/api/me")
      .then((j) => {
        setMyUserId(j.userId ?? null);
        setIsPlatformAdmin(Boolean(j.isPlatformAdmin));
        const nsAdmin = Array.isArray(j.namespaceRoles) && j.namespaceRoles.some((r) => r.role === "namespace_admin");
        setCanAudit(Boolean(j.isPlatformAdmin) || nsAdmin);
        // Usage dashboard: platform admins, namespace admins, and explicit maintainers.
        setCanUsage(Boolean(j.isPlatformAdmin) || nsAdmin || Boolean(j.maintainsSkills));
        // First-login onboarding: null marker → they haven't seen Quick start; the gate below
        // forces it once. Tri-state (null = unknown until /api/me resolves) so we never bounce
        // a user before we know their status.
        setOnboarded(j.onboardedAt != null);
      })
      .catch(() => {});
  }, [status]);

  // The Quick start page stamps onboarded on mount and fires this event — flip local state
  // immediately so the gate releases without waiting for /api/me's short cache to expire.
  useEffect(() => {
    const done = () => setOnboarded(true);
    window.addEventListener("skilly:onboarded", done);
    return () => window.removeEventListener("skilly:onboarded", done);
  }, []);

  // First-login gate: while the user has never seen Quick start, force it on any page (once).
  // Excludes the Quick start page itself so it can render + stamp. Only fires once we KNOW
  // onboarded === false (not the null "unknown" state), so authenticated users are never bounced
  // mid-load. SKILLY_SPEC.md §8.
  useEffect(() => {
    if (status !== "authenticated" || onboarded !== false) return;
    if (pathname !== "/quick-start") router.replace("/quick-start");
  }, [status, onboarded, pathname, router]);

  // Poll the unread notification count. Pauses while the tab is backgrounded (no point hitting
  // the server for a hidden badge) and refreshes immediately on regaining focus.
  useEffect(() => {
    if (status !== "authenticated") return;
    let live = true;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetch("/api/notifications")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => live && j && setUnread(Number(j.unread ?? 0)))
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    // The inbox page marks everything read on open and fires this event — clear the
    // badge immediately instead of waiting for the next poll.
    const clear = () => live && setUnread(0);
    window.addEventListener("skilly:notifications-read", clear);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("skilly:notifications-read", clear);
    };
  }, [status]);

  // Which tracked surface (if any) the user is currently viewing. We persist "seen" on LEAVE
  // (below), so while a surface is open its badge must stay cleared even if the poll recomputes a
  // non-zero count against the not-yet-advanced timestamp.
  const surfaceRef = useRef<"catalog" | "review" | "system-log" | "requests" | null>(null);

  // Mark a surface "seen" when the user LEAVES it — NOT on entry. The catalog's per-row "new" tags
  // are computed server-side against catalog_seen_at; advancing that only after the visit keeps
  // the tags AND the badge stable across in-page filtering/sorting, and matches "new = first seen
  // by you". Entering only optimistically clears the badge locally (the poll keeps it cleared for
  // the visit); leaving persists now(). §10. Requested skills mirrors this exactly (§26): opening
  // ONE request's detail page (still under /requests) counts as viewing the surface, so leaving it
  // marks every currently-open request seen, not just the one opened — same blast radius as
  // opening a single proposal already has for the review queue.
  useEffect(() => {
    if (status !== "authenticated") return;
    const surface = pathname.startsWith("/catalog") ? "catalog" : pathname.startsWith("/proposals") ? "review" : pathname.startsWith("/system-log") ? "system-log" : pathname.startsWith("/requests") ? "requests" : null;
    const prev = surfaceRef.current;
    if (prev && prev !== surface) {
      fetch("/api/nav-badges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: prev }) }).catch(() => {});
    }
    if (surface) {
      const key = surface === "system-log" ? "systemLog" : surface; // badge keys are camelCase
      setNavBadges((b) => ({ ...b, [key]: 0 }));
    }
    surfaceRef.current = surface;
  }, [status, pathname]);

  // Poll the Catalog / Review-queue "new items" badge counts. Visibility-aware (pauses when the
  // tab is hidden). The surface currently being viewed is forced to 0 — it's persisted as seen on
  // leave, so until then the poll would otherwise re-raise a badge we've already cleared.
  useEffect(() => {
    if (status !== "authenticated") return;
    let live = true;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetch("/api/nav-badges")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live || !j) return;
          const here = surfaceRef.current;
          setNavBadges({
            catalog: here === "catalog" ? 0 : Number(j.catalog ?? 0),
            review: here === "review" ? 0 : Number(j.review ?? 0),
            systemLog: here === "system-log" ? 0 : Number(j.systemLog ?? 0),
            requests: here === "requests" ? 0 : Number(j.requests ?? 0),
          });
        })
        .catch(() => {});
      // System banner (§27): same cadence, no dedicated transport. A past expiresAt is treated as
      // "no active banner" both here and server-side (lazy expiry, no worker sweep).
      fetch("/api/system-banner")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live) return;
          setSystemBanner(j && typeof j.message === "string" && new Date(j.expiresAt).getTime() > Date.now() ? j : null);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);

  // Presence page beacon (§4): a dynamic-title page's own resolved label (e.g. "Skill: <name>")
  // overrides the static route default via PageLabelOverrideProvider below.
  const [pageLabelOverride, setPageLabelOverride] = useState<string | null>(null);
  // Reset on every navigation so the beacon doesn't briefly resend the PREVIOUS route's dynamic
  // override before the new page's own effect corrects it.
  useEffect(() => { setPageLabelOverride(null); }, [pathname]);
  useEffect(() => {
    if (status !== "authenticated") return;
    const label = pageLabelOverride ?? resolveStaticPageLabel(pathname);
    if (!label) return; // unrecognized route (e.g. the /tokens redirect stub) — nothing to beacon
    fetch("/api/presence/page", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) }).catch(() => {});
  }, [status, pathname, pageLabelOverride]);

  // Track whether the sidebar still has content scrolled out of view below the fold.
  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const update = () => setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [status]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  // Close the mobile drawer + menus whenever the route changes (i.e. a nav item was tapped).
  useEffect(() => { setNavOpen(false); setAcOpen(false); setUserMenuOpen(false); }, [pathname]);

  // Close the account menu on an outside click.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (userFootRef.current && !userFootRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [userMenuOpen]);

  return (
    <div className="shell">
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden />}
      <aside ref={sidebarRef} className={`sidebar${navOpen ? " open" : ""}`}>
        {/* Brand + (mobile-only) close button share a flex row, so the close button sits to the
            RIGHT of the brand and pushes it left instead of overlapping it. The button is hidden
            on desktop, where the sidebar is always shown. */}
        <div className="sidebar-head">
          <Link href="/" className="brand">
            <span className="brand-mark">
              skilly<span className="brand-dot">.</span>
            </span>
            <span className="brand-tag">registry</span>
          </Link>
          <button type="button" className="nav-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation is for signed-in users only — when logged out we hide the whole nav
            (label + items, Overview included); the pages themselves are gated by RequireAuth. */}
        {status === "authenticated" && (
          <>
            <div className="nav-label">Navigate</div>
            {NAV.map((n) => {
              const count = n.badge ? navBadges[n.badge] : 0;
              return (
                <Link key={n.href} href={n.href} className={`nav-item${isActive(n.href) ? " active" : ""}`}>
                  <Icon d={n.icon} />
                  {n.label}
                  {count > 0 && (
                    <sup className="nav-badge" aria-label={`${count > 9 ? "9+" : count} new`}>{count > 9 ? "9+" : count}</sup>
                  )}
                </Link>
              );
            })}
          </>
        )}
        {canUsage && (
          <Link href={USAGE_NAV.href} className={`nav-item${isActive(USAGE_NAV.href) ? " active" : ""}`}>
            <Icon d={USAGE_NAV.icon} />
            {USAGE_NAV.label}
          </Link>
        )}
        {canAudit && (
          <Link href={AUDIT_NAV.href} className={`nav-item${isActive(AUDIT_NAV.href) ? " active" : ""}`}>
            <Icon d={AUDIT_NAV.icon} />
            {AUDIT_NAV.label}
          </Link>
        )}
        {isPlatformAdmin && (
          <Link href={SYSLOG_NAV.href} className={`nav-item${isActive(SYSLOG_NAV.href) ? " active" : ""}`}>
            <Icon d={SYSLOG_NAV.icon} />
            {SYSLOG_NAV.label}
            {navBadges.systemLog > 0 && (
              <sup className="nav-badge" aria-label={`${navBadges.systemLog > 9 ? "9+" : navBadges.systemLog} new`}>{navBadges.systemLog > 9 ? "9+" : navBadges.systemLog}</sup>
            )}
          </Link>
        )}
        {isPlatformAdmin && (
          <Link href={ADMIN_NAV.href} className={`nav-item${isActive(ADMIN_NAV.href) ? " active" : ""}`}>
            <Icon d={ADMIN_NAV.icon} />
            {ADMIN_NAV.label}
          </Link>
        )}

        <div className="sidebar-foot">
          {status === "authenticated" ? (
            <div className="user-foot" ref={userFootRef}>
              <button className="user-trigger" onClick={() => setUserMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={userMenuOpen}>
                <UserBubble name={session.user?.name ?? "?"} avatar={session.user?.image ?? null} userId={myUserId} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.user?.name ?? "Signed in"}</div>
                  <div style={{ fontSize: 11, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>account</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--faint)", flexShrink: 0, transform: userMenuOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
                  <path d="m6 15 6-6 6 6" />
                </svg>
              </button>
              {userMenuPresence && (
                <div className={`user-menu menu-pop${userMenuPresence === "closing" ? " menu-pop-closing" : ""}`} role="menu">
                  <Link href="/quick-start" className="user-menu-item" role="menuitem" onClick={() => setUserMenuOpen(false)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8a2 2 0 0 0-3 0zM12 15l-3-3a12 12 0 0 1 8-9 12 12 0 0 1-9 8zM15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
                    </svg>
                    Quick start
                  </Link>
                  <Link href="/whats-new" className="user-menu-item" role="menuitem" onClick={() => setUserMenuOpen(false)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4L12 3zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
                    </svg>
                    What&rsquo;s new
                  </Link>
                  <Link href="/installed" className="user-menu-item" role="menuitem" onClick={() => setUserMenuOpen(false)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
                    </svg>
                    Installed skills
                  </Link>
                  <Link href="/profile" className="user-menu-item" role="menuitem" onClick={() => setUserMenuOpen(false)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
                    </svg>
                    Profile
                  </Link>
                  <button
                    className="user-menu-item"
                    role="menuitem"
                    onClick={async () => {
                      setUserMenuOpen(false);
                      // Clear the session, then nuke any remaining auth cookies (CSRF + leftover
                      // transient OAuth cookies are httpOnly, so only the server can delete them),
                      // then land on the public home. signOut runs first — it needs the CSRF cookie.
                      try {
                        await signOut({ redirect: false });
                        await fetch("/api/auth/clear-cookies", { method: "POST" });
                      } catch { /* best-effort; still redirect */ }
                      window.location.href = "/";
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                    </svg>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="btn btn-sm" style={{ width: "100%" }} onClick={() => signIn(signInProvider)}>
              {signInProvider === "dev" ? "Sign in (dev)" : "Sign in with Entra ID"}
            </button>
          )}
        </div>

        <div className="colophon">
          <span className="colophon-version">v{APP_VERSION}</span>
          <span>
            Created by{" "}
            <a href="https://www.scalefocus.com" target="_blank" rel="noreferrer noopener">Scalefocus</a>
          </span>
          <span className="colophon-sub">powered by the community</span>
        </div>

        {/* Scroll affordance: only while there's more menu below the fold. */}
        {moreBelow && (
          <div className="scroll-hint" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        )}
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="nav-toggle" aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {/* The registry search targets the catalog, which is signed-in-only. */}
          {status === "authenticated" && (
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                // On a live-filter page (catalog/installed/usage) the box already filters the list —
                // Enter just dismisses focus (no jump to the catalog).
                if (liveFilter) { searchRef.current?.blur(); return; }
                // Enter on a highlighted suggestion jumps straight to that skill (the "see all"
                // footer sits at index === suggestions.length and falls through to the catalog).
                if (acOpen && acHi >= 0 && acHi < suggestions.length && suggestions[acHi]) {
                  const s = suggestions[acHi];
                  setAcOpen(false);
                  router.push(`/skills/${s.namespaceSlug}/${s.skillSlug}`);
                  return;
                }
                setAcOpen(false);
                router.push(`/catalog?q=${encodeURIComponent(q)}`);
              }}
              onBlur={(e) => {
                // Close the menu unless focus moved to something inside the form (a suggestion).
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setAcOpen(false);
              }}
              role="combobox"
              aria-expanded={acOpen}
              aria-haspopup="listbox"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onFocus={() => { if (!liveFilter && (suggestions.length > 0 || (q.trim().length >= 2 && !acLoading))) setAcOpen(true); }}
                onKeyDown={(e) => {
                  if (!acOpen || suggestions.length === 0) return;
                  // Navigable items = the suggestions plus the trailing "see all in catalog" footer.
                  const count = suggestions.length + 1;
                  if (e.key === "ArrowDown") { e.preventDefault(); setAcHi((i) => (i + 1) % count); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setAcHi((i) => (i <= 0 ? count - 1 : i - 1)); }
                  else if (e.key === "Escape") { setAcOpen(false); setAcHi(-1); }
                }}
                placeholder={onInstalled ? "Search installed skills…" : onUsage ? "Search usage…" : "Search the registry…"}
                aria-label={onInstalled ? "Search installed skills" : onUsage ? "Search usage" : "Search skills"}
                aria-autocomplete="list"
                autoComplete="off"
              />
              <kbd>CTRL+K</kbd>
              {acOpen && suggestions.length > 0 && (
                <ul className="search-ac" role="listbox">
                  {suggestions.map((s, i) => (
                    <li key={`${s.namespaceSlug}/${s.skillSlug}`} role="option" aria-selected={i === acHi}>
                      <button
                        type="button"
                        className={`search-ac-item${i === acHi ? " hi" : ""}`}
                        onMouseEnter={() => setAcHi(i)}
                        onClick={() => { setAcOpen(false); setQ(""); router.push(`/skills/${s.namespaceSlug}/${s.skillSlug}`); }}
                      >
                        <span className="search-ac-title">
                          {s.title}
                          {s.official && <span className="chip chip-official" style={{ marginLeft: 6 }} title="Official — endorsed by the platform"><span aria-hidden>✓</span> Official</span>}
                        </span>
                        <span className="search-ac-sub mono">@{s.namespaceSlug}/{s.skillSlug}</span>
                      </button>
                    </li>
                  ))}
                  {/* Footer: only 5 results show in the dropdown — jump to the full card/row view. */}
                  <li role="option" aria-selected={acHi === suggestions.length}>
                    <button
                      type="button"
                      className={`search-ac-item search-ac-all${acHi === suggestions.length ? " hi" : ""}`}
                      onMouseEnter={() => setAcHi(suggestions.length)}
                      onClick={() => { setAcOpen(false); router.push(`/catalog?q=${encodeURIComponent(q.trim())}`); }}
                    >
                      See all results in catalog →
                    </button>
                  </li>
                </ul>
              )}
              {/* No matches: a bubble so it's clear the search actually ran (only after the
                  request returns empty — never while typing/loading). */}
              {acOpen && !acLoading && suggestions.length === 0 && q.trim().length >= 2 && (
                <div className="search-ac search-ac-empty" role="status">
                  Nothing found for <span className="mono">“{q.trim()}”</span>
                </div>
              )}
            </form>
          )}
          <div className="topbar-spacer" />
          {status === "authenticated" && systemBanner && (
            <div className="system-banner">
              <Pill tone="accent"><span className="system-banner-text" title={systemBanner.message}>{systemBanner.message}</span></Pill>
            </div>
          )}
          {status === "authenticated" && <MessagesMenu />}
          {status === "authenticated" && (
            <Link href="/notifications" className="bell" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              </svg>
              {unread > 0 && <span className="bell-dot">{unread > 9 ? "9+" : unread}</span>}
            </Link>
          )}
          <ThemeToggle />
        </header>

        <main className="content">
          <PageLabelOverrideProvider value={setPageLabelOverride}>{children}</PageLabelOverrideProvider>
        </main>
      </div>
    </div>
  );
}
