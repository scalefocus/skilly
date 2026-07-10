"use client";
// Administration → Email notifications (§12): one of the collapsible admin cards (§5) holding the
// email channel's status pill, the connected Graph service account, connect / disconnect /
// test-send actions, and the WYSIWYG [SYSTEM MESSAGE] wrapper editor. The status pill rides in the
// card header (the accessory) so a down channel stays visible while collapsed. Platform admins only
// (the page is already gated; every API call re-verifies).
import { useEffect, useRef, useState } from "react";
import nextDynamic from "next/dynamic";
import { Pill, useApi } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { CollapsibleCard } from "./CollapsibleCard";
import { countWrapperPlaceholders, EMAIL_WRAPPER_PLACEHOLDER } from "@skilly/shared/email-template";

// TipTap is heavy — code-split it out of the admin route's initial bundle.
const WrapperEditor = nextDynamic(() => import("./WrapperEditor"), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 220, borderRadius: "var(--radius-sm)" }} />,
});

interface EmailStatus {
  connected: boolean;
  account: { upn: string; displayName: string; connectedAt: string; connectedByName: string | null } | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  wrapperHtml: string | null;
  encKeyPresent: boolean;
  smtpConfigured: boolean;
  pill: "operational" | "smtp_fallback" | "down";
  reason: "no_key" | "not_connected" | "refresh_failing" | "no_wrapper" | null;
}

const REASON_TEXT: Record<NonNullable<EmailStatus["reason"]>, string> = {
  no_key: "EMAIL_TOKEN_ENC_KEY (or the Entra client credentials) is not configured on the server, so a service account can't be connected.",
  not_connected: "No email service account is connected yet.",
  refresh_failing: "The service account's token can no longer be refreshed — reconnect it.",
  no_wrapper: "No message wrapper is saved — emails only send once a wrapper exists.",
};

function StatusPill({ s }: { s: EmailStatus }) {
  if (s.pill === "operational") return <Pill tone="ok">Email operational</Pill>;
  if (s.pill === "smtp_fallback") return <Pill tone="warn">SMTP fallback</Pill>;
  return <Pill tone="danger">Email notifications down</Pill>;
}

export function EmailCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data, reload } = useApi<EmailStatus>("/api/admin/email");
  const fmt = useDateFmt();
  // The card's open state is owned by the page; keep a ref so the mount-time redirect handler can
  // expand a *collapsed* card without a stale-closure toggle-into-collapse.
  const openRef = useRef(open);
  openRef.current = open;
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // null until the status loads

  // Returning from the Entra connect redirect: surface the outcome once, then clean the URL.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const err = qs.get("emailError");
    const ok = qs.get("email") === "connected";
    if (err) setFlash({ tone: "danger", text: `Connecting the email service account failed: ${err}` });
    else if (ok) setFlash({ tone: "ok", text: "Email service account connected." });
    if (err || ok) {
      if (!openRef.current) onToggle(); // show the outcome even though the card defaults collapsed
      qs.delete("emailError");
      qs.delete("email");
      window.history.replaceState(null, "", `${window.location.pathname}${qs.size ? `?${qs}` : ""}`);
    }
  }, []);

  useEffect(() => {
    if (data && draft === null) setDraft(data.wrapperHtml ?? "");
  }, [data, draft]);

  const call = async (input: RequestInfo, init?: RequestInit): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch(input, init);
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(String(j.error ?? `Failed (${r.status})`));
      reload();
      return j;
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Save gates on the placeholder contract only — no dirty tracking. The editor normalizes
  // the stored HTML on load (e.g. <div> → <p>), so comparing against the raw server string
  // would misreport dirtiness; an idempotent re-save is harmless.
  const placeholderCount = draft === null ? 1 : countWrapperPlaceholders(draft);

  const saveWrapper = async () => {
    const j = await call("/api/admin/email/wrapper", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ html: draft ?? "" }) });
    if (j) {
      setDraft(String(j.sanitized ?? draft ?? ""));
      setFlash({ tone: "ok", text: "Message wrapper saved." });
    }
  };

  const disconnect = async () => {
    if (!data?.account) return;
    if (!window.confirm(`Disconnect ${data.account.upn}? Notification email stops until an account is reconnected (SMTP fallback applies if configured).`)) return;
    const j = await call("/api/admin/email", { method: "DELETE" });
    if (j) setFlash({ tone: "ok", text: "Email service account disconnected." });
  };

  const sendTest = async () => {
    const j = await call("/api/admin/email/test", { method: "POST" });
    if (j) setFlash({ tone: "ok", text: `Test email sent to ${String(j.to)}.` });
  };

  return (
    <CollapsibleCard
      cardId="email"
      title="Email notifications"
      accessory={data ? <StatusPill s={data} /> : undefined}
      open={open}
      onToggle={onToggle}
    >
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
            Deliver notifications by email through a Microsoft 365 service mailbox (Graph <span className="mono">sendMail</span>).
            Sign in below <strong>as the service account</strong> — a dedicated mailbox such as{" "}
            <span className="mono">skilly-notifications@…</span> — not your own account. Users can opt out on their profile.
          </p>

          {flash && (
            <div className="card card-pad" style={{ marginBottom: 14, color: flash.tone === "danger" ? "var(--danger)" : "var(--ok)", fontSize: 13.5 }}>
              {flash.text}
            </div>
          )}

          {data ? (
            <>
              {data.reason && (
                <div style={{ fontSize: 13, color: "var(--warn)", background: "var(--warn-soft)", padding: "10px 12px", borderRadius: "var(--radius-sm)", lineHeight: 1.5, marginBottom: 14 }}>
                  {REASON_TEXT[data.reason]}
                  {data.pill === "smtp_fallback" && " Meanwhile, email is going out over the configured SMTP fallback (plain-text, no wrapper)."}
                  {data.reason === "refresh_failing" && data.lastRefreshError && (
                    <div className="mono" style={{ fontSize: 11.5, marginTop: 6, opacity: 0.85 }}>{data.lastRefreshError}</div>
                  )}
                </div>
              )}

              {data.account ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{data.account.displayName}</div>
                    <div className="muted mono" style={{ fontSize: 12.5 }}>{data.account.upn}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      connected {fmt.dateTime(data.account.connectedAt)}
                      {data.account.connectedByName ? ` by ${data.account.connectedByName}` : ""}
                      {data.lastRefreshAt && !data.lastRefreshError ? ` · token refreshed ${fmt.dateTime(data.lastRefreshAt)}` : ""}
                    </div>
                  </div>
                  <span style={{ flex: 1 }} />
                  {busy || !data.encKeyPresent ? (
                    // A real disabled button — an aria-disabled anchor would still navigate (§12:
                    // without the key the connect control is disabled with a config hint).
                    <button className="btn btn-sm" disabled title={!data.encKeyPresent ? REASON_TEXT.no_key : undefined}>Re-connect</button>
                  ) : (
                    <a className="btn btn-sm" href="/api/admin/email/connect">Re-connect</a>
                  )}
                  <button className="btn btn-sm" disabled={busy || data.pill !== "operational"} onClick={() => void sendTest()} title="Sends the current wrapper around a sample message to your own address">
                    Send test email
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => void disconnect()} style={{ color: "var(--danger)" }}>
                    Disconnect
                  </button>
                </div>
              ) : (
                <div style={{ marginBottom: 16 }}>
                  {data.encKeyPresent ? (
                    <a className="btn" href="/api/admin/email/connect">Set email service account</a>
                  ) : (
                    <button className="btn" disabled title={REASON_TEXT.no_key}>Set email service account</button>
                  )}
                </div>
              )}

              <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 4px" }}>Message wrapper</h3>
              <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                The HTML frame around every emailed notification. It must contain the placeholder{" "}
                <span className="mono">{EMAIL_WRAPPER_PLACEHOLDER}</span> exactly once — the notification text (with its links)
                replaces it, and a “Manage email notifications” footer is always appended. Without a saved wrapper, no email goes out
                over the service account.
              </p>
              {draft !== null && <WrapperEditor value={draft} onChange={setDraft} disabled={busy} />}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                <button className="btn btn-sm" disabled={busy || draft === null || placeholderCount !== 1} onClick={() => void saveWrapper()}>
                  Save wrapper
                </button>
                {placeholderCount === 0 && <span style={{ fontSize: 12.5, color: "var(--danger)" }}>Add the {EMAIL_WRAPPER_PLACEHOLDER} placeholder to enable saving.</span>}
                {placeholderCount > 1 && <span style={{ fontSize: 12.5, color: "var(--danger)" }}>The placeholder may appear only once (found {placeholderCount}).</span>}
              </div>
            </>
          ) : (
            <div className="skeleton" style={{ height: 160, borderRadius: "var(--radius-sm)" }} />
          )}
    </CollapsibleCard>
  );
}
