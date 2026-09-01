"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApi, Pill, EmptyState, ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import { ExpiryPicker } from "../../components/ExpiryPicker";
import { filterMarketplaces } from "../../lib/marketplaceFilter";

/** One added Claude plugin marketplace (SKILLY_SPEC.md §30.6). */
interface Marketplace {
  id: string;
  scope: "public" | "namespace";
  namespaceSlug: string | null;
  name: string;
  addedAt: string;
  expiresAt: string | null;
  inactive: boolean;
  clientUserAgent: string | null;
  clientIp: string | null;
  stillServed: boolean;
}

interface MintResult {
  name: string;
  command: string;
  gitConfigCommand: string;
  plainCommand: string;
}

function CopyLine({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>{label}</span>
        <button
          className="btn btn-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 6 }}>
        {value}
      </pre>
      {hint && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/** Adding the PUBLIC marketplace needs no admin rights (§30.4), and there is no admin page a
 *  regular consumer would visit — so the offer lives here, above their list. */
function AddPublic({ name, maxMonths }: { name: string; maxMonths: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintResult | null>(null);

  const mint = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/marketplaces/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "public", expiresAt: expiry }),
      });
      const j = (await r.json().catch(() => ({}))) as MintResult & { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Failed to generate");
      setMinted(j);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 14.5 }}>Public marketplace</span>
        <span className="mono muted" style={{ fontSize: 11.5 }}>{name}</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Every skill in this organization that everyone can see, as Claude Code plugins.
      </div>
      {err && <div style={{ fontSize: 13, color: "var(--danger)" }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>key expiry</span>
        <ExpiryPicker maxMonths={maxMonths} onChange={setExpiry} />
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void mint()}>
          Generate add command
        </button>
      </div>
      {minted && (
        <>
          <CopyLine label="Run in Claude Code" value={minted.command} />
          <CopyLine
            label="If background updates fail"
            value={`${minted.gitConfigCommand}\n${minted.plainCommand}`}
            hint="Claude Code turns off git credential helpers for background marketplace updates. Run the git config line once, then add the marketplace with the credential-free URL."
          />
        </>
      )}
    </div>
  );
}

/** Best-effort friendly client label from the git User-Agent (OS is usually absent). */
function clientLabel(ua: string | null): string {
  if (!ua) return "unknown client";
  const m = /git\/([\d.]+)/i.exec(ua);
  return m ? `git ${m[1]}` : ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

function MarketplacesInner() {
  const fmt = useDateFmt();
  const q = (useSearchParams().get("q") ?? "").trim();
  const { data: me } = useApi<{ installMaxTtlMonths?: number }>("/api/me");
  const { data, loading, error, reload } = useApi<{ marketplaces: Marketplace[]; publicMarketplace?: { enabled: boolean; name: string } }>("/api/marketplaces");
  const marketplaces = data?.marketplaces ?? [];
  const filtered = filterMarketplaces(marketplaces, q);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateIso, setActivateIso] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);

  const remove = async (m: Marketplace) => {
    if (
      !window.confirm(
        `Remove ${m.name}? Its URL stops working, so Claude Code can no longer add or update from it. Plugins already installed on your machine keep working.`,
      )
    )
      return;
    setBusyId(m.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/marketplaces/tokens/${m.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to remove");
      setMsg({ kind: "ok", text: "Removed." });
      reload();
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusyId(null);
    }
  };

  const reactivate = async (m: Marketplace) => {
    setBusyId(m.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/marketplaces/tokens/${m.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresAt: activateIso }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to reactivate");
      setActivatingId(null);
      setActivateIso(null);
      setMsg({ kind: "ok", text: "Reactivated — your existing marketplace URL works again." });
      reload();
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Account</div>
        <h1 className="page-title">Added marketplaces.</h1>
        <p className="page-sub">
          Claude Code plugin marketplaces you’ve added. Each carries a unique key — remove one to revoke its URL, or
          reactivate an expired one to revive the same URL without re-adding it.
        </p>
      </div>

      {msg && (
        <div style={{ marginBottom: 14, fontSize: 13.5, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>
      )}

      {data?.publicMarketplace?.enabled && (
        <AddPublic name={data.publicMarketplace.name} maxMonths={me?.installMaxTtlMonths ?? 12} />
      )}

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load your marketplaces" hint={error} />
      ) : loading ? (
        <div className="rows">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="row" key={i}>
              <div className="skeleton" style={{ height: 16, width: "45%" }} />
            </div>
          ))}
        </div>
      ) : marketplaces.length === 0 ? (
        <EmptyState
          title="No marketplaces added yet"
          hint="Generate an add command from Namespace administration (or the public marketplace card) and run it in Claude Code — it’ll show up here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState title={`No marketplaces match “${q}”`} hint="Clear the search to see all of yours." />
      ) : (
        <div className="rows reveal">
          {filtered.map((m) => (
            <div className="row installed-row" key={m.id}>
              <div className="install-main">
                <div className="version-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{m.name}</span>
                  <div className="ns mono" style={{ fontSize: 11.5 }}>
                    {m.scope === "public" ? "public marketplace" : `@${m.namespaceSlug}`}
                  </div>
                </div>
                <div className="install-meta">
                  <Pill tone="muted">{m.scope === "public" ? "public" : "namespace"}</Pill>
                  {/* The switch was turned off platform-side: the URL 404s regardless of expiry,
                      and reactivating cannot bring it back — only re-enabling the marketplace can. */}
                  {!m.stillServed && <Pill tone="warn">switched off</Pill>}
                  {m.inactive ? <Pill tone="danger">inactive</Pill> : <Pill tone="ok">active</Pill>}
                  <span className="muted mono" style={{ fontSize: 11 }} title={m.clientUserAgent ?? ""}>
                    {clientLabel(m.clientUserAgent)}
                  </span>
                  {m.clientIp && (
                    <span className="muted mono" style={{ fontSize: 11 }} title="IP this marketplace was added from">
                      from {m.clientIp}
                    </span>
                  )}
                  <span className="muted mono" style={{ fontSize: 11 }}>added {fmt.date(m.addedAt)}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {m.expiresAt ? `expires ${fmt.date(m.expiresAt)}` : "never expires"}
                  </span>
                </div>
              </div>
              <div className="version-actions">
                {m.inactive && m.stillServed && (
                  <button
                    className="btn btn-sm"
                    disabled={busyId === m.id}
                    onClick={() => {
                      setActivatingId(activatingId === m.id ? null : m.id);
                      setActivateIso(null);
                    }}
                  >
                    activate
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  disabled={busyId === m.id}
                  onClick={() => remove(m)}
                  title="Delete this marketplace key and revoke its URL"
                >
                  remove
                </button>
              </div>
              {activatingId === m.id && (
                <div
                  style={{
                    flexBasis: "100%",
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginTop: 10,
                    paddingTop: 10,
                    borderTop: "1px solid var(--line)",
                  }}
                >
                  <span className="muted" style={{ fontSize: 12.5 }}>new expiry</span>
                  <ExpiryPicker maxMonths={me?.installMaxTtlMonths ?? 12} onChange={setActivateIso} />
                  <button className="btn btn-sm btn-primary" disabled={busyId === m.id} onClick={() => reactivate(m)}>
                    Reactivate
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MarketplacesPage() {
  return (
    <RequireAuth>
      {/* MarketplacesInner reads ?q= via useSearchParams — needs a Suspense boundary. */}
      <Suspense
        fallback={
          <div className="rows">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="row" key={i}>
                <div className="skeleton" style={{ height: 16, width: "45%" }} />
              </div>
            ))}
          </div>
        }
      >
        <MarketplacesInner />
      </Suspense>
    </RequireAuth>
  );
}
