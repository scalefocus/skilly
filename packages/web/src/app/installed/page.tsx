"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi, Pill, EmptyState, ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import { ExpiryPicker } from "../../components/ExpiryPicker";

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
  /** System-installs view only (§23): the platform admin who minted it. */
  mintedBy?: string | null;
}

/** Which installs to list: the caller's own, or (platform admins only) all system installs. §23 */
type Scope = "mine" | "system";

/** Best-effort friendly client label from the git User-Agent (OS is usually absent). */
function clientLabel(ua: string | null): string {
  if (!ua) return "unknown client";
  const m = /git\/([\d.]+)/i.exec(ua);
  return m ? `git ${m[1]}` : ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

function InstalledInner() {
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
  const installs = data?.installs ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateIso, setActivateIso] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);

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
        {me?.isPlatformAdmin && (
          // Platform admins only (§23): flip between the personal view and all system installs.
          <div className="sort-toggle" role="group" aria-label="Install scope">
            <button type="button" className={`sort-opt${scope === "mine" ? " sort-on" : ""}`} onClick={() => setScope("mine")}>Mine</button>
            <button type="button" className={`sort-opt${scope === "system" ? " sort-on" : ""}`} onClick={() => setScope("system")}>System installs</button>
          </div>
        )}
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
      ) : (
        <div className="rows reveal">
          {installs.map((i) => (
            <div
              className="row installed-row"
              key={i.id}
              style={{ cursor: "pointer" }}
              onClick={() => router.push(`/skills/${i.namespaceSlug}/${i.skillSlug}`)}
            >
              <div className="install-main">
                <div className="version-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                  <Link href={`/skills/${i.namespaceSlug}/${i.skillSlug}`} style={{ fontWeight: 600, fontSize: 14.5 }}>{i.title}</Link>
                  <div className="ns mono" style={{ fontSize: 11.5 }}>@{i.namespaceSlug}/{i.skillSlug}</div>
                </div>
                <div className="install-meta">
                  <Pill tone="muted">{i.pinnedSemver ? `v${i.pinnedSemver}` : "latest"}</Pill>
                  {scope === "system" && <Pill tone="accent">System install</Pill>}
                  {i.skillArchived && <Pill tone="warn">archived</Pill>}
                  {i.inactive ? <Pill tone="danger">inactive</Pill> : <Pill tone="ok">active</Pill>}
                  <span className="muted mono" style={{ fontSize: 11 }} title={i.clientUserAgent ?? ""}>{clientLabel(i.clientUserAgent)}</span>
                  {i.clientIp && <span className="muted mono" style={{ fontSize: 11 }} title="IP this skill was installed from">from {i.clientIp}</span>}
                  <span className="muted mono" style={{ fontSize: 11 }}>installed {fmt.date(i.installedAt)}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>{i.expiresAt ? `expires ${fmt.date(i.expiresAt)}` : "never expires"}</span>
                  {scope === "system" && <span className="muted mono" style={{ fontSize: 11 }} title="Platform admin who generated this system install">minted by {i.mintedBy ?? "unknown"}</span>}
                </div>
              </div>
              {/* Interactive controls stop the click from bubbling to the row's navigate handler —
                  otherwise "uninstall"/"activate" would both fire their action AND navigate away. */}
              <div className="version-actions" onClick={(e) => e.stopPropagation()}>
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
      <InstalledInner />
    </RequireAuth>
  );
}
