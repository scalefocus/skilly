"use client";
// Administration → Signing (SKILLY_SPEC.md §73.8, §73.9), platform admins only: the active signing
// key (keyId, full fingerprint, registered at), retired keys, revoked keys (who, when, why), Revoke
// on every key not yet revoked (final, reasoned, audited — revoking the ACTIVE key pauses publishing
// until a new key is configured), statement counts by kind, versions without a valid statement and
// the re-sign backlog, and the last 50 mismatch reports (§73.11).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { EmptyState, Modal, Pill, useApi } from "../../../components/ui";
import { RequireAuth } from "../../../components/RequireAuth";
import { useDateFmt } from "../../../components/DateFormat";
// Type-only (erased at build time): the server module itself never reaches the client bundle.
import type { SigningAdminView, SigningKeyView } from "../../../lib/signing";

const MAX_REASON = 500;

function Signing() {
  const fmt = useDateFmt();
  const { data: me, loading: meLoading } = useApi<{ isPlatformAdmin?: boolean }>("/api/me");
  const [view, setView] = useState<SigningAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<SigningKeyView | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/signing", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as SigningAdminView & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      setError(null);
      setView(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (me?.isPlatformAdmin) void load();
  }, [me?.isPlatformAdmin, load]);

  if (!meLoading && me && !me.isPlatformAdmin) {
    return <EmptyState icon="🔒" title="Platform admins only" hint="Signing keys are managed by platform administrators." />;
  }

  const active = view?.keys.find((k) => k.status === "active") ?? null;
  const retired = view?.keys.filter((k) => k.status === "retired") ?? [];
  const revoked = view?.keys.filter((k) => k.status === "revoked") ?? [];
  const backfillPending = view ? Math.max(0, view.unsigned - view.resignPending) : 0;
  const h2 = { fontFamily: "var(--font-display)", fontSize: 18, margin: "0 0 10px" } as const;

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Administration</div>
        <h1 className="page-title">Signing.</h1>
        <p className="page-sub">
          skilly signs every version it publishes with its platform key, so anyone can check that their files are the ones skilly served.{" "}
          <Link href="/verify?tab=offline">How people verify</Link>
        </p>
      </div>

      {error && !view && <EmptyState icon="⚠" title="Couldn’t load signing" hint={error} />}
      {!view && !error && <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />}

      {view && (
        <>
          {!active && (
            <div className="card card-pad" role="alert" style={{ marginBottom: 16, borderColor: "var(--danger)", fontSize: 13.5 }} data-testid="signing-paused">
              {revoked.length > 0 ? (
                <>
                  <strong>Signing is paused: the active key was revoked.</strong> Publishing stops until you configure a new key. Set{" "}
                  <span className="mono">SKILLY_SIGNING_KEY</span> (or <span className="mono">SKILLY_SIGNING_KEY_FILE</span>) for the worker to a new key —{" "}
                  <span className="mono">openssl genpkey -algorithm ed25519 -out skilly-signing.pem</span> — and restart it.
                </>
              ) : (
                <>
                  <strong>No signing key is registered yet.</strong> The worker registers its key when it starts; publishing waits until it does.
                </>
              )}
            </div>
          )}

          <section className="card card-pad" style={{ marginBottom: 16 }} data-testid="signing-active-key">
            <h2 style={h2}>Active key</h2>
            {active ? (
              <KeyBlock k={active} onRevoke={() => setRevoking(active)} />
            ) : (
              <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>None.</p>
            )}
          </section>

          <section className="card card-pad" style={{ marginBottom: 16 }} data-testid="signing-counts">
            <h2 style={h2}>Statements</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Stat label="Publish" value={view.counts.publish} />
              <Stat label="Backfill" value={view.counts.backfill} />
              <Stat label="Re-sign" value={view.counts.resign} />
              <Stat label="Variants" value={view.counts.variants} />
              <Stat label="Without a valid statement" value={view.unsigned} warn={view.unsigned > 0} testId="signing-unsigned" />
              <Stat label="Re-sign pending" value={view.resignPending} warn={view.resignPending > 0} />
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
              Counts are of statements signed by keys that aren&rsquo;t revoked.{" "}
              {view.unsigned === 0
                ? "Every published version has a valid statement."
                : `${backfillPending} ${backfillPending === 1 ? "version waits" : "versions wait"} for the backfill and ${view.resignPending} for a re-sign; the worker works through them in batches.`}
            </p>
          </section>

          {(retired.length > 0 || revoked.length > 0) && (
            <section className="card card-pad" style={{ marginBottom: 16 }} data-testid="signing-older-keys">
              <h2 style={h2}>Older keys</h2>
              <div style={{ display: "grid", gap: 14 }}>
                {retired.map((k) => (
                  <KeyBlock key={k.keyId} k={k} onRevoke={() => setRevoking(k)} />
                ))}
                {revoked.map((k) => (
                  <KeyBlock key={k.keyId} k={k} />
                ))}
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: "12px 0 0" }}>
                A retired key&rsquo;s statements stay valid. A revoked key&rsquo;s statements read &ldquo;revoked key&rdquo; until the worker re-signs them with the active key.
              </p>
            </section>
          )}

          <section className="card card-pad" data-testid="signing-reports">
            <h2 style={h2}>Mismatch reports</h2>
            {view.reports.length === 0 ? (
              <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>No one has reported a mismatch.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr className="muted mono" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>
                      {["When", "Reported by", "Version", "Files", "Note"].map((h) => (
                        <th key={h} style={{ padding: "6px 10px", textAlign: "left", borderBottom: "1px solid var(--line)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {view.reports.map((r, i) => (
                      <tr key={`${r.at}-${i}`} data-testid="signing-report">
                        <td style={td}>{fmt.dateTime(r.at)}</td>
                        <td style={td}>{r.reporter ?? "Unknown user"}</td>
                        <td style={td}>
                          {r.skill ? <Link href={`/skills/${r.skill}#version-${r.semver}`} className="mono">{r.skill}@{r.semver}</Link> : <span className="mono">{r.semver}</span>}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {r.counts.modified ?? 0} modified · {r.counts.missing ?? 0} missing · {r.counts.extra ?? 0} extra
                        </td>
                        <td style={{ ...td, whiteSpace: "pre-wrap", minWidth: 180 }}>{r.note ?? <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {revoking && (
        <RevokeDialog
          k={revoking}
          onClose={() => setRevoking(null)}
          onDone={async (text) => {
            setRevoking(null);
            setToast(text);
            await load();
          }}
        />
      )}
      {toast && typeof document !== "undefined" && createPortal(<div className="toast" role="status">{toast}</div>, document.body)}
    </div>
  );
}

const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--line)", textAlign: "left", verticalAlign: "top" };

function Stat({ label, value, warn, testId }: { label: string; value: number; warn?: boolean; testId?: string }) {
  return (
    <div style={{ padding: "8px 12px", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", minWidth: 110 }} data-testid={testId}>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: warn ? "var(--warn, #b45309)" : "var(--ink)" }}>{value.toLocaleString("en")}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );
}

function KeyBlock({ k, onRevoke }: { k: SigningKeyView; onRevoke?: () => void }) {
  const fmt = useDateFmt();
  return (
    <div data-testid="signing-key" data-status={k.status} style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>{k.keyId}</span>
          {k.status === "active" ? <Pill tone="ok">active</Pill> : k.status === "retired" ? <Pill tone="muted">retired</Pill> : <Pill tone="danger">revoked</Pill>}
          <span className="muted mono" style={{ fontSize: 11 }}>{k.algorithm}</span>
        </div>
        <div className="mono" style={{ fontSize: 12.5, marginTop: 6, overflowWrap: "anywhere" }} title="sha256 of the public key (DER SPKI)">{k.fingerprintDisplay}</div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          registered {fmt.dateTime(k.createdAt)}
          {k.retiredAt && <> · retired {fmt.dateTime(k.retiredAt)}</>}
          {k.revokedAt && <> · revoked {fmt.dateTime(k.revokedAt)}{k.revokedBy ? ` by ${k.revokedBy.name ?? "an unknown user"}` : ""}</>}
          {" · "}{k.statements.toLocaleString("en")} {k.statements === 1 ? "statement" : "statements"}
        </div>
        {k.revokedReason && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>Reason: {k.revokedReason}</div>}
      </div>
      {onRevoke && k.status !== "revoked" && (
        <button type="button" className="btn btn-sm btn-danger" onClick={onRevoke} data-testid="signing-revoke">Revoke…</button>
      )}
    </div>
  );
}

function RevokeDialog({ k, onClose, onDone }: { k: SigningKeyView; onClose: () => void; onDone: (text: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const submit = async () => {
    if (busy || !reason.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/signing/keys/${encodeURIComponent(k.keyId)}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { statementsAffected?: number; error?: string };
      if (r.ok) {
        const n = j.statementsAffected ?? 0;
        await onDone(`Key revoked. ${n} ${n === 1 ? "statement" : "statements"} will be re-signed.`);
        return;
      }
      if (r.status === 409) {
        await onDone("This key was already revoked.");
        return;
      }
      setErr(j.error ?? `Couldn't revoke the key (${r.status}).`);
    } catch {
      setErr("Couldn't revoke the key. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Revoke key ${k.keyId}?`}
      onCancel={onClose}
      initialFocusRef={first}
      testId="signing-revoke-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => void submit()} disabled={busy || !reason.trim()} data-testid="signing-revoke-confirm">
            {busy ? "Revoking…" : "Revoke key"}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 14, marginTop: 0 }}>
        Revoking can&rsquo;t be undone. Every statement this key signed ({k.statements.toLocaleString("en")}) then reads &ldquo;revoked key&rdquo;, whatever
        its date, until the worker re-signs it with the active key.
      </p>
      {k.status === "active" && (
        <p role="alert" style={{ fontSize: 14, color: "var(--danger)", fontWeight: 600 }} data-testid="signing-revoke-active-warning">
          This is the active key. Publishing stops until you configure a new key.
        </p>
      )}
      <label htmlFor={id} className="field-label">Reason (required, recorded in the audit log)</label>
      <textarea
        ref={first}
        id={id}
        className="input"
        rows={3}
        maxLength={MAX_REASON}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: "100%", resize: "vertical", fontSize: 14 }}
        data-testid="signing-revoke-reason"
      />
      {err && <p role="alert" style={{ color: "var(--danger)", fontSize: 13, marginBottom: 0 }}>{err}</p>}
    </Modal>
  );
}

export default function SigningPage() {
  return (
    <RequireAuth>
      <Signing />
    </RequireAuth>
  );
}
