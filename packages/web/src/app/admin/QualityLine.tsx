"use client";
import { useCallback, useEffect, useState } from "react";

interface Progress { active: number; scored: number; aiDone: number; aiFailed: number; aiPending: number; ruleset: number }

/** Maintenance line (§41.7): how far the quality sweep has got, plus "Re-run quality assessment". */
export function QualityLine() {
  const [p, setP] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/jobs/quality");
      if (r.ok) setP(await r.json());
    } catch { /* transient — the poll retries */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const outstanding = !!p && (p.scored < p.active || p.aiPending > 0);
  useEffect(() => {
    if (!outstanding) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [outstanding, load]);
  const rescore = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/admin/jobs/quality/rescore", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      setNote(r.ok ? `${j.rows ?? 0} version${j.rows === 1 ? "" : "s"} queued — the sweep re-scores them in the background.` : j.error ?? `HTTP ${r.status}`);
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Quality</div>
        <div className="muted mono" style={{ fontSize: 11.5 }} data-testid="quality-progress">
          {p ? `${p.scored} / ${p.active} versions scored · ${p.aiDone} with AI · ${p.aiFailed} AI failed${p.aiPending ? ` · ${p.aiPending} AI pending` : ""} · ruleset ${p.ruleset}` : "…"}
        </div>
        {note && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{note}</div>}
      </div>
      <button className="btn btn-sm" disabled={busy} onClick={rescore} data-testid="quality-rescore">
        {busy ? "queuing…" : "Re-run quality assessment"}
      </button>
    </div>
  );
}
