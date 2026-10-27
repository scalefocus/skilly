"use client";
import { Suspense, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi, Pill, EmptyState, ScrollToTop, CopyCommand } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import { ExpiryPicker } from "../../components/ExpiryPicker";
import { SkillIcon } from "../../components/SkillIcon";
import { filterBehind, filterInstalls, installRef, installedHighlightHref, INSTALLED_SORT_KEY, parseInstalledSort, type InstalledSort } from "../../lib/installedFilter";
import { activeCounts, cardCountLabel, groupInstalls, lastInstalledAt, versionModes, worstFreshness, type InstallEntry } from "../../lib/installedGroups";
import { requestInstall, type ExistingInstall, type OnExisting } from "../../lib/installMint";
import { AlreadyInstalledDialog } from "../../components/AlreadyInstalledDialog";
import type { Freshness } from "@skilly/shared/freshness";

interface Install {
  id: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  pinnedSemver: string | null;
  installedAt: string;
  expiresAt: string | null;
  inactive: boolean;
  clientUserAgent: string | null;
  clientIp: string | null;
  skillArchived: boolean;
  /** §45: the skill is deprecated (successor only when this viewer can see it). */
  skillDeprecation?: { note: string | null; successor: { namespaceSlug: string; skillSlug: string; title: string } | null } | null;
  /** System-installs view only (§23): the platform admin who minted it. */
  mintedBy?: string | null;
  /** Optional skill icon (§33) — image and/or emoji, or null. */
  icon?: { url: string | null; emoji: string | null } | null;
  /** Freshness (§23 "Installed-version freshness"): what the gateway last served, vs latest stable. */
  lastServedSemver: string | null;
  lastClonedAt: string | null;
  latestSemver: string | null;
  freshness: Freshness;
  /** §23 "Show install URL": the row has a recoverable copy (and the key is configured). */
  revealable: boolean;
}

/** Which installs to list: the caller's own, or (platform admins only) all system installs. §23 */
type Scope = "mine" | "system";

/** Best-effort friendly client label from the git User-Agent (OS is usually absent). */
function clientLabel(ua: string | null): string {
  if (!ua) return "unknown client";
  const m = /git\/([\d.]+)/i.exec(ua);
  return m ? `git ${m[1]}` : ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

/**
 * The per-row freshness line (§23 "Installed-version freshness"):
 *   pinned + behind     → "pinned v1.2.0 · latest v1.4.0"
 *   latest + behind     → "cloned v1.2.0 on ‹date› · latest v1.4.0"
 *   withdrawn           → "installed v1.2.0 · withdrawn · latest v1.4.0"
 *   current             → "installed v1.4.0 · up to date"
 *   unknown             → "installed version unknown — re-run the install command to record it"
 */
function freshnessLine(i: Install, date: (iso: string) => string): string {
  const latest = i.latestSemver ? `latest v${i.latestSemver}` : "no stable version published";
  switch (i.freshness) {
    case "current":
      return `installed v${i.lastServedSemver} · up to date`;
    case "behind":
      return i.pinnedSemver
        ? `pinned v${i.lastServedSemver} · ${latest}`
        : `cloned v${i.lastServedSemver}${i.lastClonedAt ? ` on ${date(i.lastClonedAt)}` : ""} · ${latest}`;
    case "withdrawn":
      return `installed v${i.lastServedSemver} · withdrawn · ${latest}`;
    default:
      return "installed version unknown — re-run the install command to record it";
  }
}

/** Caption under a revealed install command (§23 "Show install URL"). */
function revealCaption(i: Install, system: boolean, date: (iso: string) => string): string {
  const parts = [
    i.pinnedSemver ? `pinned v${i.pinnedSemver}` : "latest",
    i.expiresAt ? `expires ${date(i.expiresAt)}` : "never expires",
    system ? "a shared credential" : "anyone with this URL can install as you",
  ];
  if (i.inactive) parts.push("inactive — this URL is refused until you reactivate it");
  return parts.join(" · ");
}

// Reads the URL and hands the list its inputs. The header search rewrites ?q= on every keystroke, so
// this wrapper is all that re-renders urgently: the query reaches the (memoised) list deferred, and
// the list re-filters and re-renders at a lower priority that typing can interrupt.
function InstalledInner() {
  // The app-shell header search mirrors its query into ?q= on /installed (§23). We read it here and
  // filter the already-loaded list client-side — no refetch. Empty query → full list.
  const params = useSearchParams();
  const q = useDeferredValue((params.get("q") ?? "").trim());
  // The "Behind latest" chip (§23 "Installed-version freshness"): default off, mirrored to
  // ?filter=behind (kept out of history, seeded from the URL on arrival — same treatment as ?q=),
  // persists across the Mine/System toggle, and composes with the header search.
  const behindOnly = params.get("filter") === "behind";
  // Built from the live URL at click time (which ?q= keeps current), so the callback stays stable
  // across keystrokes and doesn't defeat the list's memo. Written with history.replaceState — the
  // same way the header search writes ?q= — not router.replace: the chip filters an already-loaded
  // list, so a server round-trip buys nothing, and Next syncs useSearchParams with the history API,
  // so the chip and the list flip in the same tick instead of after an RSC fetch that a loaded
  // server can hold up (or that a later ?q= rewrite can race).
  const setBehindOnly = useCallback((on: boolean) => {
    const next = new URLSearchParams(window.location.search);
    if (on) next.set("filter", "behind"); else next.delete("filter");
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `/installed?${qs}` : "/installed");
  }, []);
  return <InstalledList q={q} behindOnly={behindOnly} highlightParam={params.get("highlight")} setBehindOnly={setBehindOnly} />;
}

const InstalledList = memo(function InstalledList({ q, behindOnly, highlightParam, setBehindOnly }: {
  q: string;
  behindOnly: boolean;
  highlightParam: string | null;
  setBehindOnly: (on: boolean) => void;
}) {
  const fmt = useDateFmt();
  const router = useRouter();
  // Admin-configured install-expiry horizon (calendar months) — bounds the reactivate picker. §23
  const { data: me } = useApi<{ installMaxTtlMonths?: number; isPlatformAdmin?: boolean }>("/api/me");
  // Platform admins can flip to the System installs view: platform-owned installs (CI/org tools),
  // manageable by any platform admin. Default is the personal view. §23 "System installations".
  const [scope, setScope] = useState<Scope>("mine");
  const { data, loading, error, reload } = useApi<{ installs: Install[] }>(
    scope === "system" ? "/api/installs?scope=system" : "/api/installs",
  );
  const installs = useMemo(() => data?.installs ?? [], [data]);
  // Sort toggle (§23): A–Z (default) or Recently installed, remembered per browser — one preference
  // for both scopes. Read after mount (no localStorage during SSR); blocked storage → A–Z every visit.
  const [sort, setSort] = useState<InstalledSort>("alpha");
  useEffect(() => {
    try { setSort(parseInstalledSort(window.localStorage.getItem(INSTALLED_SORT_KEY))); } catch { /* storage blocked → A–Z */ }
  }, []);
  const pickSort = (next: InstalledSort) => {
    setSort(next);
    try { window.localStorage.setItem(INSTALLED_SORT_KEY, next); } catch { /* per-browser convenience only */ }
  };
  // §23: case-insensitive substring match over title + @ns/slug (see lib/installedFilter). Applies
  // in both scopes; the query persists across the Mine/System toggle (it lives in the URL).
  const visible = useMemo(() => filterInstalls(filterBehind(installs, behindOnly), q), [installs, behindOnly, q]);
  // §23 "One card per skill": filter FIRST, then group — a skill with 2+ visible installs is one
  // collapsible card, one visible install a plain row. Entries follow the chosen sort.
  const entries = useMemo(() => groupInstalls(visible, installs, sort), [visible, installs, sort]);

  // Highlight on arrival (§23): ?highlight=<ns>/<slug> is where the already-installed prompt's
  // "Go to skill" lands. Force Mine, clear the header search (?q= and its box) and the Behind chip
  // so the rows can't be filtered out, then drop the param so a reload doesn't re-flash. The sort
  // choice is kept. Every row of that skill gets an accent ring that fades after ~3 s.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightParam) return;
    setScope("mine");
    setFlash(highlightParam);
    // A grouped skill's card opens (and stays open through the scope/chip resets below).
    keepOpen.current = highlightParam;
    setExpanded((prev) => new Set(prev).add(highlightParam));
    window.dispatchEvent(new Event("skilly:clear-search"));
    router.replace("/installed", { scroll: false });
  }, [highlightParam, router]);
  useEffect(() => {
    if (!flash || loading) return;
    // Nothing of that skill is installed (e.g. uninstalled in another tab) → nothing to highlight.
    if (!installs.some((i) => installRef(i) === flash)) { setFlash(null); keepOpen.current = null; return; }
    const t = setTimeout(() => { setFlash(null); keepOpen.current = null; }, 3000);
    return () => clearTimeout(t);
  }, [flash, loading, installs]);
  // Scrolls the highlighted skill's entry (its row, or its card) into view once it is on the page (a
  // new callback per flash, so React re-attaches it — and scrolls — even when it was already mounted).
  const scrollToFlash = useCallback((el: HTMLDivElement | null) => {
    if (el && flash) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [flash]);

  // Card open/closed (§23 "One card per skill"): collapsed on every visit, nothing persisted.
  // Turning the Behind chip on opens every card (one can still be closed by hand while it is on);
  // switching it off, or switching Mine ⇄ System, collapses them all again. Declared AFTER the
  // highlight effect so a ?highlight= target opened on the same commit survives the reset.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [closedWhileBehind, setClosedWhileBehind] = useState<Set<string>>(() => new Set());
  const keepOpen = useRef<string | null>(null);
  useEffect(() => {
    setExpanded(new Set(keepOpen.current ? [keepOpen.current] : []));
    setClosedWhileBehind(new Set());
  }, [scope, behindOnly]);
  const isOpen = (ref: string) => (behindOnly ? !closedWhileBehind.has(ref) : expanded.has(ref));
  const toggleCard = (ref: string) => {
    const flip = (prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref); else next.add(ref);
      return next;
    };
    if (behindOnly) setClosedWhileBehind(flip); else setExpanded(flip);
  };

  // §23 "Show install URL": the row whose command panel is open, and the command fetched for it.
  const [revealFor, setRevealFor] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ rowId: string; command: string } | null>(null);
  // Bumped on every open/close, so a slow response for a row the user has since moved on from is
  // dropped instead of landing in (or closing) the panel that is open now.
  const revealSeq = useRef(0);
  // Closing a panel also drops the command from state — a credential shouldn't linger in memory.
  const closeReveal = useCallback(() => { revealSeq.current++; setRevealFor(null); setRevealed(null); }, []);
  useEffect(() => { closeReveal(); }, [scope, closeReveal]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateIso, setActivateIso] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  // §45.5 "Install latest": mint a personal install of the SUCCESSOR at latest from a deprecated row.
  const [successorFor, setSuccessorFor] = useState<string | null>(null);
  const [successorIso, setSuccessorIso] = useState<string | null>(null);
  const [successorPending, setSuccessorPending] = useState(false);
  const [successorCmd, setSuccessorCmd] = useState<{ rowId: string; command: string; expiresAt: string | null } | null>(null);
  // The already-installed prompt for the successor (§23/§45.5): set while the dialog is open.
  const [succExisting, setSuccExisting] = useState<{ row: Install; installs: ExistingInstall[] } | null>(null);
  const [succExistingErr, setSuccExistingErr] = useState<string | null>(null);

  // Mints the SUCCESSOR at latest. Asks first (§23 "Already-installed prompt"): when the user already
  // holds the successor, the dialog re-posts with "replace" (Override — replaces only the successor's
  // installs, never this deprecated row) or "keep" (Install anyway).
  const installSuccessor = async (i: Install, onExisting: OnExisting = "ask") => {
    const succ = i.skillDeprecation?.successor;
    if (!succ) return;
    if (successorPending) { setMsg({ kind: "err", text: "Pick an expiry date first, or switch the expiry to Never." }); return; }
    setBusyId(i.id); setMsg(null); setSuccExistingErr(null);
    const inDialog = succExisting !== null;
    try {
      const out = await requestInstall(succ.namespaceSlug, succ.skillSlug, { semver: null, expiresAt: successorIso, onExisting });
      if (out.kind === "already_installed") { setSuccExisting({ row: i, installs: out.installs }); return; }
      if (out.kind === "error") throw new Error(out.message);
      setSuccExisting(null);
      setSuccessorCmd({ rowId: i.id, command: out.install.command, expiresAt: out.install.expiresAt });
      setMsg({ kind: "ok", text: `Install command for ${succ.title} generated — run it, then uninstall this one when you're ready.` });
      if (onExisting === "replace") reload(); // the successor's replaced rows are gone
    } catch (e) {
      const text = String((e as Error).message);
      if (inDialog) setSuccExistingErr(text); else setMsg({ kind: "err", text });
    } finally { setBusyId(null); }
  };

  const toggleReveal = async (i: Install) => {
    if (revealFor === i.id) { closeReveal(); return; }
    const seq = ++revealSeq.current;
    // One inline panel per row: opening the URL closes the Activate / Install-latest panels.
    setRevealFor(i.id); setRevealed(null); setActivatingId(null); setSuccessorFor(null);
    setBusyId(i.id); setMsg(null);
    try {
      const r = await fetch(`/api/installs/${i.id}/command`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { command?: string; error?: string };
      if (seq !== revealSeq.current) return; // superseded by a later open/close
      if (!r.ok || !j.command) throw new Error(j.error ?? "Couldn’t load the install URL");
      setRevealed({ rowId: i.id, command: j.command });
    } catch (e) {
      if (seq === revealSeq.current) { closeReveal(); setMsg({ kind: "err", text: String((e as Error).message) }); }
    } finally { setBusyId((b) => (b === i.id ? null : b)); }
  };

  const uninstall = async (i: Install) => {
    const what = scope === "system" ? `the SYSTEM install of ${i.namespaceSlug}/${i.skillSlug}? Anything using it (CI, org tools) will lose access` : `${i.namespaceSlug}/${i.skillSlug}? The install URL will stop working`;
    if (!window.confirm(`Uninstall ${what}.`)) return;
    setBusyId(i.id); setMsg(null);
    try {
      const r = await fetch(`/api/installs/${i.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to uninstall");
      setMsg({ kind: "ok", text: "Uninstalled." });
      reload();
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusyId(null); }
  };

  const reactivate = async (i: Install) => {
    setBusyId(i.id); setMsg(null);
    try {
      const r = await fetch(`/api/installs/${i.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresAt: activateIso }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to reactivate");
      setActivatingId(null); setActivateIso(null);
      setMsg({ kind: "ok", text: "Reactivated — your existing install URL works again." });
      reload();
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusyId(null); }
  };

  // §45.5 Install latest — a SKILL-level action: on a plain row it sits with the row's actions, on a
  // card it sits on the header (`i` is then the card's newest install, standing in for the skill).
  const successorButton = (i: Install) =>
    scope === "mine" && i.skillDeprecation?.successor ? (
      // Mints the SUCCESSOR at latest (Mine scope only); never uninstalls this skill's installs.
      <button
        className="btn btn-sm btn-primary"
        disabled={busyId === i.id}
        onClick={() => { setSuccessorFor(successorFor === i.id ? null : i.id); setSuccessorIso(null); setSuccessorCmd(null); setActivatingId(null); closeReveal(); }}
        title={`Generate an install command for ${i.skillDeprecation.successor.title} (latest)`}
        data-testid="install-latest"
      >
        install latest
      </button>
    ) : null;

  const successorPanel = (i: Install) =>
    successorFor === i.id && i.skillDeprecation?.successor ? (
      <div
        style={{ flexBasis: "100%", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}
        onClick={(e) => e.stopPropagation()}
        data-testid="install-latest-panel"
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12.5 }}>install <strong>{i.skillDeprecation.successor.title}</strong> (latest) · expires</span>
          <ExpiryPicker maxMonths={me?.installMaxTtlMonths ?? 12} onChange={setSuccessorIso} onPendingChange={setSuccessorPending} />
          <button className="btn btn-sm btn-primary" disabled={busyId === i.id} onClick={() => installSuccessor(i)} data-testid="install-latest-generate">
            {busyId === i.id ? "Working…" : "Generate command"}
          </button>
        </div>
        {successorCmd?.rowId === i.id && (
          <>
            <CopyCommand command={successorCmd.command} autoCopy />
            <div className="muted mono" style={{ fontSize: 11, marginTop: 8 }}>
              latest · {successorCmd.expiresAt ? `expires ${fmt.dateTime(successorCmd.expiresAt)}` : "never expires"} · this install stays until you uninstall it
            </div>
          </>
        )}
      </div>
    ) : null;

  // The skill-level markers (§23/§45.5) — on a plain row inline, on a card on its header.
  const skillPills = (i: Install) => (
    <>
      {scope === "system" && <Pill tone="accent">System install</Pill>}
      {i.skillArchived && <Pill tone="warn">archived</Pill>}
      {i.skillDeprecation && (
        <span title={i.skillDeprecation.successor ? `Deprecated — use ${i.skillDeprecation.successor.title} instead` : "Deprecated"} data-testid="installed-deprecated-pill"><Pill tone="warn">deprecated</Pill></span>
      )}
    </>
  );
  const successorLine = (i: Install) =>
    i.skillDeprecation?.successor ? (
      // §45.5: the marker's sentence + a link to the successor (the row click still opens THIS skill).
      <div className="muted" style={{ flexBasis: "100%", fontSize: 12, marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
        Deprecated — use <Link href={`/skills/${i.skillDeprecation.successor.namespaceSlug}/${i.skillDeprecation.successor.skillSlug}`} style={{ fontWeight: 600 }}>{i.skillDeprecation.successor.title}</Link> instead.
      </div>
    ) : null;

  // One install. "row" = a plain list row (the skill's only visible install): identity, skill-level
  // markers and actions included. "child" = one install inside a card: only the per-install details
  // and actions — the card header carries the skill (§23 "One card per skill").
  const renderInstall = (i: Install, mode: "row" | "child") => {
    const row = mode === "row";
    return (
      <div
        className={`row installed-row${row ? "" : " installed-child"}${row && flash && installRef(i) === flash ? " install-flash" : ""}`}
        key={i.id}
        ref={row && installRef(i) === flash ? scrollToFlash : undefined}
        data-install-ref={row ? installRef(i) : undefined}
        data-install-id={i.id}
        style={{ cursor: "pointer" }}
        onClick={() => router.push(`/skills/${i.namespaceSlug}/${i.skillSlug}`)}
      >
        <div className="install-main" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {row && (
            <>
              <SkillIcon icon={i.icon} title={i.title} size={24} />
              <div className="version-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                <Link href={`/skills/${i.namespaceSlug}/${i.skillSlug}`} style={{ fontWeight: 600, fontSize: 14.5 }}>{i.title}</Link>
                <div className="ns mono" style={{ fontSize: 11.5 }}>@{i.namespaceSlug}/{i.skillSlug}</div>
              </div>
            </>
          )}
          <div className="install-meta">
            <Pill tone="muted">{i.pinnedSemver ? `pinned v${i.pinnedSemver}` : "latest"}</Pill>
            {/* Freshness badge (§23): behind / withdrawn only — "current" and "unknown" carry no badge. */}
            {i.freshness === "behind" && <Pill tone="warn">Behind</Pill>}
            {i.freshness === "withdrawn" && <Pill tone="danger">Withdrawn</Pill>}
            {row && skillPills(i)}
            {i.inactive ? <Pill tone="danger">inactive</Pill> : <Pill tone="ok">active</Pill>}
            <span className="muted mono" style={{ fontSize: 11 }} title={i.clientUserAgent ?? ""}>{clientLabel(i.clientUserAgent)}</span>
            {i.clientIp && <span className="muted mono" style={{ fontSize: 11 }} title="IP this skill was installed from">from {i.clientIp}</span>}
            <span className="muted mono" style={{ fontSize: 11 }}>installed {fmt.date(i.installedAt)}</span>
            <span className="muted mono" style={{ fontSize: 11 }}>{i.expiresAt ? `expires ${fmt.date(i.expiresAt)}` : "never expires"}</span>
            {scope === "system" && <span className="muted mono" style={{ fontSize: 11 }} title="Platform admin who generated this system install">minted by {i.mintedBy ?? "unknown"}</span>}
          </div>
          {/* Freshness line (§23 "Installed-version freshness"): what this install is running vs latest. */}
          <div className="install-freshness muted mono" data-freshness={i.freshness} style={{ flexBasis: "100%", fontSize: 11, marginTop: 4 }}>
            {freshnessLine(i, fmt.date)}
          </div>
          {row && successorLine(i)}
        </div>
        {/* Interactive controls stop the click from bubbling to the row's navigate handler —
            otherwise "uninstall"/"activate" would both fire their action AND navigate away. */}
        <div className="version-actions" onClick={(e) => e.stopPropagation()}>
          {row && successorButton(i)}
          {i.revealable && (
            // §23 "Show install URL": re-show this install's command (rows without a stored copy have no button).
            <button
              className="btn btn-sm"
              disabled={busyId === i.id}
              aria-expanded={revealFor === i.id}
              onClick={() => void toggleReveal(i)}
              title="Show this install's command again"
              data-testid="show-install-url"
            >
              show install URL
            </button>
          )}
          {i.inactive && (
            <button className="btn btn-sm" disabled={busyId === i.id} onClick={() => { setActivatingId(activatingId === i.id ? null : i.id); setActivateIso(null); closeReveal(); }}>
              activate
            </button>
          )}
          <button className="btn btn-sm" disabled={busyId === i.id} onClick={() => uninstall(i)} title="Delete this install and revoke its URL">
            uninstall
          </button>
        </div>
        {revealFor === i.id && revealed?.rowId === i.id && (
          <div
            style={{ flexBasis: "100%", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}
            onClick={(e) => e.stopPropagation()}
            data-testid="install-url-panel"
          >
            {/* The mint box's look (copy button, click-to-copy) — but never auto-copied. */}
            <CopyCommand command={revealed.command} />
            <div className="muted mono" style={{ fontSize: 11, marginTop: 8 }}>{revealCaption(i, scope === "system", fmt.dateTime)}</div>
          </div>
        )}
        {activatingId === i.id && (
          <div
            style={{ flexBasis: "100%", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="muted" style={{ fontSize: 12.5 }}>new expiry</span>
            <ExpiryPicker maxMonths={me?.installMaxTtlMonths ?? 12} onChange={setActivateIso} />
            <button className="btn btn-sm btn-primary" disabled={busyId === i.id} onClick={() => reactivate(i)}>Reactivate</button>
          </div>
        )}
        {row && successorPanel(i)}
      </div>
    );
  };

  // A skill with 2+ visible installs (§23 "One card per skill"): a header that summarises them and
  // toggles the card, then — when open — one child row per install, newest first.
  const renderCard = (e: Extract<InstallEntry<Install>, { kind: "card" }>) => {
    const head = e.installs[0]!; // newest install — stands in for the skill (title, icon, markers)
    const open = isOpen(e.ref);
    const worst = worstFreshness(e.installs);
    const counts = activeCounts(e.installs);
    const last = lastInstalledAt(e.installs);
    const bodyId = `install-card-${head.id}`;
    return (
      <div
        key={e.ref}
        className={`installed-card${flash === e.ref ? " install-flash" : ""}`}
        ref={e.ref === flash ? scrollToFlash : undefined}
        data-install-ref={e.ref}
        data-testid="install-card"
      >
        <div className="row installed-row installed-card-head" style={{ cursor: "pointer" }} onClick={() => toggleCard(e.ref)}>
          <div className="install-main" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              className="install-card-toggle"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              aria-label={`${open ? "Collapse" : "Expand"} ${head.title} installations`}
              onClick={(ev) => { ev.stopPropagation(); toggleCard(e.ref); }}
            >
              {open ? "▾" : "▸"}
            </button>
            <SkillIcon icon={head.icon} title={head.title} size={24} />
            <div className="version-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
              {/* The title still opens the skill page (it doesn't toggle the card). */}
              <Link href={`/skills/${head.namespaceSlug}/${head.skillSlug}`} style={{ fontWeight: 600, fontSize: 14.5 }} onClick={(ev) => ev.stopPropagation()}>{head.title}</Link>
              <div className="ns mono" style={{ fontSize: 11.5 }}>@{head.namespaceSlug}/{head.skillSlug}</div>
            </div>
            <div className="install-meta">
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }} data-testid="install-card-count">{cardCountLabel(e.installs.length, e.total)}</span>
              <span className="muted mono" style={{ fontSize: 11 }} data-testid="install-card-versions">{versionModes(e.installs).join(" · ")}</span>
              {worst === "behind" && <Pill tone="warn">Behind</Pill>}
              {worst === "withdrawn" && <Pill tone="danger">Withdrawn</Pill>}
              {counts.active > 0 && <Pill tone="ok">{counts.active} active</Pill>}
              {counts.inactive > 0 && <Pill tone="danger">{counts.inactive} inactive</Pill>}
              {skillPills(head)}
              {last && <span className="muted mono" style={{ fontSize: 11 }}>last installed {fmt.date(last)}</span>}
            </div>
            {successorLine(head)}
          </div>
          <div className="version-actions" onClick={(ev) => ev.stopPropagation()}>{successorButton(head)}</div>
          {successorPanel(head)}
        </div>
        {open && (
          <div id={bodyId} className="installed-card-body">
            {e.installs.map((i) => renderInstall(i, "child"))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head reveal" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Account</div>
          <h1 className="page-title">Installed skills.</h1>
          <p className="page-sub">
            {scope === "system"
              ? "Platform-owned installs for CI pipelines and org tools — not tied to any user. Any platform admin can uninstall or reactivate them; changes are audited."
              : "Skills you’ve installed. Each carries a unique key — uninstall to revoke its URL, or reactivate an expired one."}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {me?.isPlatformAdmin && (
            // Platform admins only (§23): flip between the personal view and all system installs.
            <div className="sort-toggle" role="group" aria-label="Install scope">
              <button type="button" className={`sort-opt${scope === "mine" ? " sort-on" : ""}`} onClick={() => setScope("mine")}>Mine</button>
              <button type="button" className={`sort-opt${scope === "system" ? " sort-on" : ""}`} onClick={() => setScope("system")}>System installs</button>
            </div>
          )}
          {/* Sort (§23): A–Z (default) or Recently installed — remembered in this browser. */}
          <div className="sort-toggle" role="group" aria-label="Sort installs">
            <button type="button" className={`sort-opt${sort === "alpha" ? " sort-on" : ""}`} aria-pressed={sort === "alpha"} onClick={() => pickSort("alpha")}>
              A–Z
            </button>
            <button type="button" className={`sort-opt${sort === "recent" ? " sort-on" : ""}`} aria-pressed={sort === "recent"} onClick={() => pickSort("recent")}>
              Recently installed
            </button>
          </div>
          {/* "Behind latest" (§23): show only installs running an older or withdrawn version. */}
          <div className="sort-toggle" role="group" aria-label="Freshness filter">
            <button
              type="button"
              className={`sort-opt${behindOnly ? " sort-on" : ""}`}
              aria-pressed={behindOnly}
              onClick={() => setBehindOnly(!behindOnly)}
              title="Show only installs that are behind the latest version, or whose version was withdrawn"
            >
              Behind latest
            </button>
          </div>
        </div>
      </div>

      {msg && <div style={{ marginBottom: 14, fontSize: 13.5, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}
      {succExisting?.row.skillDeprecation?.successor && (() => {
        const row = succExisting.row;
        const succ = succExisting.row.skillDeprecation.successor;
        return (
          <AlreadyInstalledDialog
            title={succ.title}
            installs={succExisting.installs}
            busy={busyId === row.id}
            error={succExistingErr}
            onGoTo={() => {
              setSuccExisting(null); setSuccessorFor(null);
              router.replace(installedHighlightHref(succ.namespaceSlug, succ.skillSlug), { scroll: false });
            }}
            onOverride={() => void installSuccessor(row, "replace")}
            onInstallAnyway={() => void installSuccessor(row, "keep")}
            onCancel={() => { setSuccExisting(null); setSuccExistingErr(null); }}
          />
        );
      })()}

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load your installs" hint={error} />
      ) : loading ? (
        <div className="rows">{Array.from({ length: 3 }).map((_, i) => <div className="row" key={i}><div className="skeleton" style={{ height: 16, width: "45%" }} /></div>)}</div>
      ) : installs.length === 0 ? (
        scope === "system" ? (
          <EmptyState title="No system installs yet" hint="Tick “System install” when generating an install command on a skill’s page — once claimed, it’ll show up here for every platform admin." />
        ) : (
          <EmptyState title="No installs yet" hint="Generate an install command from a skill’s page and run it — it’ll show up here." />
        )
      ) : visible.length === 0 ? (
        // There ARE installs, but none match the header search / the Behind-latest chip — distinct
        // from the empty states above. With a query set, the search miss wins and names both. §23
        q ? (
          <EmptyState
            title={`No installed skills match “${q}”`}
            hint={behindOnly ? "Clear the search or switch off “Behind latest” to see more." : `Clear the search to see all ${scope === "system" ? "system installs" : "your installs"}.`}
          />
        ) : (
          <EmptyState icon="✓" title="Everything is up to date." hint={`No ${scope === "system" ? "system install" : "install"} is behind the latest version. Switch off “Behind latest” to see all of them.`} />
        )
      ) : (
        <div className="rows reveal">
          {entries.map((e) => (e.kind === "row" ? renderInstall(e.install, "row") : renderCard(e)))}
        </div>
      )}
    </div>
  );
});

export default function InstalledPage() {
  return (
    <RequireAuth>
      {/* InstalledInner reads ?q= via useSearchParams — needs a Suspense boundary (like the catalog). */}
      <Suspense fallback={<div className="rows">{Array.from({ length: 3 }).map((_, i) => <div className="row" key={i}><div className="skeleton" style={{ height: 16, width: "45%" }} /></div>)}</div>}>
        <InstalledInner />
      </Suspense>
    </RequireAuth>
  );
}
