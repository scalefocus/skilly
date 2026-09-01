"use client";
import { useState } from "react";
import { useApi, Pill, EmptyState, ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { ExpiryPicker } from "../../components/ExpiryPicker";
import { MaintainerContactField } from "../../components/MaintainerContactField";

/** One namespace the caller administers (SKILLY_SPEC.md §30.6). */
interface NamespaceRow {
  id: string;
  slug: string;
  displayName: string;
  requireReview: boolean;
  requireReviewLocked: boolean;
  maintainerContact: string | null;
  marketplaceEnabled: boolean;
  marketplaceName: string;
  marketplaceSkillCount: number;
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

function NamespaceCard({ ns, maxMonths, onChanged }: { ns: NamespaceRow; maxMonths: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  const [minted, setMinted] = useState<MintResult | null>(null);
  const [addExpiry, setAddExpiry] = useState<string | null>(null);

  const patch = async (body: Record<string, unknown>, okText: string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/namespaces/${ns.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; tokensRevoked?: number };
      if (!r.ok) throw new Error(j.error ?? "Failed to save");
      const revoked = j.tokensRevoked ?? 0;
      // `okText: null` = the caller shows its own confirmation (the maintainer-contact field).
      if (okText !== null) {
        setMsg({ kind: "ok", text: revoked > 0 ? `${okText} ${revoked} marketplace key${revoked === 1 ? "" : "s"} revoked.` : okText });
      }
      setMinted(null);
      onChanged();
      return true;
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleMarketplace = async () => {
    if (ns.marketplaceEnabled) {
      if (
        !window.confirm(
          `Disable the ${ns.marketplaceName} marketplace?\n\nIts URL stops working and every key for it is revoked, so nobody can add or update from it. Plugins already installed on people's machines keep working.`,
        )
      )
        return;
    }
    await patch({ marketplaceEnabled: !ns.marketplaceEnabled }, ns.marketplaceEnabled ? "Marketplace disabled." : "Marketplace enabled — it appears within the sync interval.");
  };

  const mint = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/marketplaces/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "namespace", namespaceSlug: ns.slug, expiresAt: addExpiry }),
      });
      const j = (await r.json().catch(() => ({}))) as MintResult & { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Failed to generate");
      setMinted(j);
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{ns.displayName}</span>
        <span className="ns mono" style={{ fontSize: 11.5 }}>@{ns.slug}</span>
        {ns.marketplaceEnabled ? <Pill tone="ok">marketplace on</Pill> : <Pill tone="muted">marketplace off</Pill>}
      </div>

      {msg && <div style={{ fontSize: 13, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}

      {/* --- Review policy ------------------------------------------------- */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
          <input
            type="checkbox"
            checked={ns.requireReview}
            disabled={busy || ns.requireReviewLocked}
            onChange={(e) => patch({ requireReview: e.target.checked }, "Review policy saved.")}
          />
          Require review for submissions
        </label>
        {ns.requireReviewLocked && (
          <span className="muted" style={{ fontSize: 12 }}>
            the global namespace always requires review
          </span>
        )}
      </div>

      {/* --- Maintainer contact (§30.6) ------------------------------------
          The same component the Administration card uses, in its `inline` layout: the label sits
          beside the field like every other settings row on this card, while the input, typeahead
          and validation are shared so the two surfaces cannot drift. */}
      <MaintainerContactField
        value={ns.maintainerContact}
        busy={busy}
        layout="inline"
        onSave={(v) => patch({ maintainerContact: v }, null)}
      />

      {/* --- Claude plugin marketplace ------------------------------------ */}
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Claude plugin marketplace</span>
          <span className="mono muted" style={{ fontSize: 11.5 }}>{ns.marketplaceName}</span>
          <button className="btn btn-sm" disabled={busy} onClick={toggleMarketplace}>
            {ns.marketplaceEnabled ? "disable" : "enable"}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 5 }}>
          Publishes this namespace’s {ns.marketplaceSkillCount} restricted skill{ns.marketplaceSkillCount === 1 ? "" : "s"} as
          Claude Code plugins. Org-visible skills are not here — they live in the public marketplace.
        </div>

        {ns.marketplaceEnabled && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12.5 }}>key expiry</span>
              <ExpiryPicker maxMonths={maxMonths} onChange={setAddExpiry} />
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={mint}>
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
        )}
      </div>
    </div>
  );
}

function NamespacesInner() {
  const { data: me } = useApi<{ installMaxTtlMonths?: number }>("/api/me");
  const { data, loading, error, reload } = useApi<{ namespaces: NamespaceRow[] }>("/api/namespaces/administered");
  const namespaces = data?.namespaces ?? [];
  // Skeletons are for the FIRST load only. `reload()` (which every save calls, to pick up
  // revoked-key counts and the stored value) also flips `loading`, and swapping the list for
  // skeletons unmounts every card — which destroyed the state holding each card's confirmation,
  // so "✓ Saved", "Review policy saved." and the marketplace messages could never be read. While
  // a refetch is in flight the already-rendered list stays put.
  const firstLoad = loading && data === null;

  return (
    <div style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Namespace administration</div>
        <h1 className="page-title">Run your namespaces.</h1>
        <p className="page-sub">
          Settings for every namespace you administer — review policy, maintainer contact, and the Claude plugin
          marketplace. Platform admins can also edit these from Administration.
        </p>
      </div>

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load your namespaces" hint={error} />
      ) : firstLoad ? (
        <div className="rows">
          {Array.from({ length: 2 }).map((_, i) => (
            <div className="row" key={i}>
              <div className="skeleton" style={{ height: 16, width: "45%" }} />
            </div>
          ))}
        </div>
      ) : namespaces.length === 0 ? (
        <EmptyState title="No namespaces to administer" hint="You’ll see a namespace here once you’re made an admin of one." />
      ) : (
        <div className="rows reveal">
          {namespaces.map((ns) => (
            <NamespaceCard key={ns.id} ns={ns} maxMonths={me?.installMaxTtlMonths ?? 12} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function NamespacesPage() {
  return (
    <RequireAuth>
      <NamespacesInner />
    </RequireAuth>
  );
}
