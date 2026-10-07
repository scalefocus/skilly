"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi, Pill, EmptyState, ScrollToTop, CopyCommand } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import { ExpiryPicker } from "../../components/ExpiryPicker";
import { SkillIcon } from "../../components/SkillIcon";
import { filterBehind, filterInstalls } from "../../lib/installedFilter";
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

function InstalledInner() {
  const fmt = useDateFmt();
  const router = useRouter();
  // The app-shell header search mirrors its query into ?q= on /installed (§23). We read it here and
  // filter the already-loaded list client-side — no refetch. Empty query → full list.
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  // The "Behind latest" chip (§23 "Installed-version freshness"): default off, mirrored to
  // ?filter=behind via router.replace (kept out of history, seeded from the URL on arrival — same
  // treatment as ?q=), persists across the Mine/System toggle, and composes with the header search.
  const behindOnly = params.get("filter") === "behind";
  const setBehindOnly = (on: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (on) next.set("filter", "behind"); else next.delete("filter");
    const qs = next.toString();
    router.replace(qs ? `/installed?${qs}` : "/installed", { scroll: false });
  };
  // Admin-configured install-expiry horizon (calendar months) — bounds the reactivate picker. §23
  const { data: me } = useApi<{ installMaxTtlMonths?: number; isPlatformAdmin?: boolean }>("/api/me");
  // Platform admins can flip to the System installs view: platform-owned installs (CI/org tools),
  // manageable by any platform admin. Default is the personal view. §23 "System installations".
  const [scope, setScope] = useState<Scope>("mine");
  const { data, loading, error, reload } = useApi<{ installs: Install[] }>(
    scope === "system" ? "/api/installs?scope=system" : "/api/installs",
  );
  const installs = data?.installs ?? [];
  // §23: case-insensitive substring match over title + @ns/slug (see lib/installedFilter). Applies
  // in both scopes; the query persists across the Mine/System toggle (it lives in the URL).
  const filtered = filterInstalls(filterBehind(installs, behindOnly), q);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateIso, setActivateIso] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  // §45.5 "Install latest": mint a personal install of the SUCCESSOR at latest from a deprecated row.
  const [successorFor, setSuccessorFor] = useState<string | null>(null);
  const [successorIso, setSuccessorIso] = useState<string | null>(null);
  const [successorPending, setSuccessorPending] = useState(false);
  const [successorCmd, setSuccessorCmd] = useState<{ rowId: string; command: string; expiresAt: string | null } | null>(null);

  const installSuccessor = async (i: Install) => {
    const succ = i.skillDeprecation?.successor;
    if (!succ) return;
    if (successorPending) { setMsg({ kind: "err", text: "Pick an expiry date first, or switch the expiry to Never." }); return; }
    setBusyId(i.id); setMsg(null);
    try {
      const r = await fetch(`/api/skills/${succ.namespaceSlug}/${succ.skillSlug}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semver: null, expiresAt: successorIso }),
      });
      const j = (await r.json().catch(() => ({}))) as { command?: string; expiresAt?: string | null; error?: string };
      if (!r.ok || !j.command) throw new Error(j.error ?? "Failed to generate the install command");
      setSuccessorCmd({ rowId: i.id, command: j.command, expiresAt: j.expiresAt ?? null });
      setMsg({ kind: "ok", text: `Install command for ${succ.title} generated — run it, then uninstall this one when you're ready.` });
    } catch (e) { setMsg({ kind: "err", text: String((e as Error).message) }); } finally { setBusyId(null); }
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
      ) : filtered.length === 0 ? (
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
          {filtered.map((i) => (
            <div
              className="row installed-row"
              key={i.id}
              style={{ cursor: "pointer" }}
              onClick={() => router.push(`/skills/${i.namespaceSlug}/${i.skillSlug}`)}
            >
              <div className="install-main" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <SkillIcon icon={i.icon} title={i.title} size={24} />
                <div className="version-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                  <Link href={`/skills/${i.namespaceSlug}/${i.skillSlug}`} style={{ fontWeight: 600, fontSize: 14.5 }}>{i.title}</Link>
                  <div className="ns mono" style={{ fontSize: 11.5 }}>@{i.namespaceSlug}/{i.skillSlug}</div>
                </div>
                <div className="install-meta">
                  <Pill tone="muted">{i.pinnedSemver ? `pinned v${i.pinnedSemver}` : "latest"}</Pill>
                  {/* Freshness badge (§23): behind / withdrawn only — "current" and "unknown" carry no badge. */}
                  {i.freshness === "behind" && <Pill tone="warn">Behind</Pill>}
                  {i.freshness === "withdrawn" && <Pill tone="danger">Withdrawn</Pill>}
                  {scope === "system" && <Pill tone="accent">System install</Pill>}
                  {i.skillArchived && <Pill tone="warn">archived</Pill>}
                  {i.skillDeprecation && (
                    <span title={i.skillDeprecation.successor ? `Deprecated — use ${i.skillDeprecation.successor.title} instead` : "Deprecated"} data-testid="installed-deprecated-pill"><Pill tone="warn">deprecated</Pill></span>
                  )}
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
                {i.skillDeprecation?.successor && (
                  // §45.5: the marker's sentence + a link to the successor (the row click still opens THIS skill).
                  <div className="muted" style={{ flexBasis: "100%", fontSize: 12, marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
                    Deprecated — use <Link href={`/skills/${i.skillDeprecation.successor.namespaceSlug}/${i.skillDeprecation.successor.skillSlug}`} style={{ fontWeight: 600 }}>{i.skillDeprecation.successor.title}</Link> instead.
                  </div>
                )}
              </div>
              {/* Interactive controls stop the click from bubbling to the row's navigate handler —
                  otherwise "uninstall"/"activate" would both fire their action AND navigate away. */}
              <div className="version-actions" onClick={(e) => e.stopPropagation()}>
                {scope === "mine" && i.skillDeprecation?.successor && (
                  // §45.5 Install latest: mints the SUCCESSOR at latest (Mine scope only); never uninstalls this row.
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busyId === i.id}
                    onClick={() => { setSuccessorFor(successorFor === i.id ? null : i.id); setSuccessorIso(null); setSuccessorCmd(null); setActivatingId(null); }}
                    title={`Generate an install command for ${i.skillDeprecation.successor.title} (latest)`}
                    data-testid="install-latest"
                  >
                    install latest
                  </button>
                )}
                {i.inactive && (
                  <button className="btn btn-sm" disabled={busyId === i.id} onClick={() => { setActivatingId(activatingId === i.id ? null : i.id); setActivateIso(null); }}>
                    activate
                  </button>
                )}
                <button className="btn btn-sm" disabled={busyId === i.id} onClick={() => uninstall(i)} title="Delete this install and revoke its URL">
                  uninstall
                </button>
              </div>
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
              {successorFor === i.id && i.skillDeprecation?.successor && (
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
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
