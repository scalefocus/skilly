"use client";
// Administration → System message (§27): platform admins post a short, ephemeral, org-wide banner
// shown as an accent pill in every signed-in user's header, between the search box and the messages
// button. Saving always replaces whatever is active and restarts the countdown from now, whether
// the new duration is longer or shorter. Expiry is lazy (no worker sweep) — once expiresAt passes,
// this card's "currently active" summary reverts to the empty state on its own.
import { useEffect, useState } from "react";
import { Pill, useApi } from "../../components/ui";
import { CollapsibleCard } from "./CollapsibleCard";

const SYSTEM_BANNER_MAX_LEN = 100;
const DURATIONS = [
  { hours: 1, label: "1h" },
  { hours: 4, label: "4h" },
  { hours: 8, label: "8h" },
  { hours: 24, label: "1d" },
  { hours: 168, label: "1w" }, // 7 days
  { hours: 720, label: "1m" }, // fixed 30-day span, not a calendar month
] as const;
type DurationHours = (typeof DURATIONS)[number]["hours"];

const field = { padding: "8px 11px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 } as const;

interface SystemBanner { message: string; expiresAt: string }

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m remaining`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h remaining` : `${hours}h ${rem}m remaining`;
}

export function SystemBannerCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data, reload } = useApi<SystemBanner | null>("/api/admin/system-banner");
  const [text, setText] = useState("");
  const [hours, setHours] = useState<DurationHours>(1);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  // Re-render every 30s so the "remaining" readout counts down, and so a banner that expires while
  // the admin has this card open clears its own "currently active" summary without a reload (§27).
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const active = data && new Date(data.expiresAt).getTime() > Date.now() ? data : null;

  const call = async (input: RequestInfo, init?: RequestInit): Promise<boolean> => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch(input, init);
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      reload();
      return true;
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    const ok = await call("/api/admin/system-banner", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, durationHours: hours }),
    });
    if (ok) {
      setText("");
      setFlash({ tone: "ok", text: "System message posted." });
    }
  };

  const onClear = async () => {
    if (!window.confirm("Remove the system message from every user's header right now?")) return;
    const ok = await call("/api/admin/system-banner", { method: "DELETE" });
    if (ok) setFlash({ tone: "ok", text: "System message cleared." });
  };

  return (
    <CollapsibleCard
      cardId="systembanner"
      title="System message"
      accessory={active ? <Pill tone="accent">Active</Pill> : undefined}
      open={open}
      onToggle={onToggle}
    >
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        A short, org-wide announcement shown as a pill in every signed-in user’s header. Saving
        always replaces the current message and restarts the countdown from now, whether the new
        duration is longer or shorter than what was left. It disappears on its own once the
        duration elapses, or you can clear it immediately below.
      </p>

      {flash && (
        <div className="card card-pad" style={{ marginBottom: 14, color: flash.tone === "danger" ? "var(--danger)" : "var(--ok)", fontSize: 13.5 }}>
          {flash.text}
        </div>
      )}

      {active && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <Pill tone="accent">{active.message}</Pill>
          <span className="muted" style={{ fontSize: 12.5 }}>{formatRemaining(active.expiresAt)}</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" disabled={busy} onClick={() => void onClear()} style={{ color: "var(--danger)" }}>
            Clear now
          </button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          aria-label="System message"
          value={text}
          disabled={busy}
          maxLength={SYSTEM_BANNER_MAX_LEN}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void onSave(); }}
          placeholder="e.g. Scheduled maintenance tonight 22:00–23:00 UTC"
          style={{ ...field, flex: 1, minWidth: 260, maxWidth: 460 }}
        />
        <span className="muted mono" style={{ fontSize: 11.5 }}>{text.length}/{SYSTEM_BANNER_MAX_LEN}</span>
        <div className="sort-toggle" role="group" aria-label="Duration">
          {DURATIONS.map((d) => (
            <button key={d.hours} type="button" className={`sort-opt${hours === d.hours ? " sort-on" : ""}`} disabled={busy} aria-pressed={hours === d.hours} onClick={() => setHours(d.hours)}>
              {d.label}
            </button>
          ))}
        </div>
        <button className="btn btn-sm" disabled={busy || !text.trim()} onClick={() => void onSave()}>Save</button>
      </div>
    </CollapsibleCard>
  );
}
