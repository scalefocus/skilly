"use client";
// Administration → Hype (SKILLY_SPEC.md §50.8): the on/off switch and the four numbers — hypes per
// week, the recency window, the install threshold and the top N. Each change saves through
// PATCH /api/admin/settings (platform admin; validated server-side, 422 shown inline; audited per
// key as settings.updated). Off is dormant, not destructive: existing hypes are kept.
import { useEffect, useState } from "react";
import { Switch, useApi } from "../../components/ui";
import { CollapsibleCard } from "./CollapsibleCard";
import { HYPE_SETTING_RANGES, hypeSettingsSummary, type HypeSettings } from "@skilly/shared/hype";

interface HypeSettingsView {
  hypeEnabled: boolean;
  hypeBudget: number;
  hypeRecencyDays: number;
  hypeInstallThreshold: number;
  hypeTopN: number;
}

type NumField = "hypeBudget" | "hypeRecencyDays" | "hypeInstallThreshold" | "hypeTopN";
const RANGE: Record<NumField, { min: number; max: number; label: string; unit: string; hint: string }> = {
  hypeBudget: { ...HYPE_SETTING_RANGES.budget, unit: "per person, per 7 days", hint: "How many hypes each person can spend in any rolling 7 days." },
  hypeRecencyDays: { ...HYPE_SETTING_RANGES.recencyDays, unit: "days", hint: "A skill can be hyped while its first version is at most this old." },
  hypeInstallThreshold: { ...HYPE_SETTING_RANGES.installThreshold, unit: "installs", hint: "…and while it has fewer installs than this." },
  hypeTopN: { ...HYPE_SETTING_RANGES.topN, unit: "skills", hint: "How many top skills are Hyped: the pill, the home page section and the maintainer notification." },
};

function NumberSetting({ field, value, busy, onSave }: { field: NumField; value: number; busy: boolean; onSave: (field: NumField, n: number) => Promise<boolean> }) {
  const r = RANGE[field];
  const saved = String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved && draft.trim() !== "";
  const save = async () => {
    const ok = await onSave(field, Number(draft.trim()));
    if (!ok) setDraft(draft);
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ minWidth: 170, fontWeight: 600, fontSize: 13.5 }}>{r.label}</span>
        <input
          type="number"
          min={r.min}
          max={r.max}
          step={1}
          aria-label={r.label}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) void save(); }}
          className="input input-mono"
          style={{ width: 110 }}
        />
        <span className="muted" style={{ fontSize: 13 }}>{r.unit}</span>
        <button className="btn btn-sm" disabled={busy || !dirty} onClick={() => void save()}>Save</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{r.hint} Whole number, {r.min}–{r.max.toLocaleString("en-US")}.</div>
    </div>
  );
}

export function HypeCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data, reload } = useApi<HypeSettingsView>("/api/admin/settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: Partial<HypeSettingsView>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        setError(String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${r.status})`));
        return false;
      }
      reload();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const settings: HypeSettings | null = data
    ? { enabled: data.hypeEnabled, budget: data.hypeBudget, recencyDays: data.hypeRecencyDays, installThreshold: data.hypeInstallThreshold, topN: data.hypeTopN }
    : null;

  return (
    <CollapsibleCard cardId="hype" title="Hype" summary={settings ? hypeSettingsSummary(settings) : undefined} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
        People spend a few hypes a week on new, little-installed skills to push them up the <strong>Hyped skills</strong> board.
        The top few are marked Hyped, shown above Featured on the home page, and their maintainers are told. Early hypes
        count for more. Switching this off hides every hype surface; existing hypes are kept, so nothing is lost.
      </p>
      {error && <div style={{ fontSize: 13, color: "var(--danger)", marginBottom: 10 }} data-testid="hype-settings-error">{error}</div>}
      {!data ? (
        <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius-sm)" }} />
      ) : (
        <>
          <Switch label="Allow hypes" checked={data.hypeEnabled} disabled={busy} onChange={(next) => void patch({ hypeEnabled: next })} style={{ marginBottom: 16 }} />
          {(Object.keys(RANGE) as NumField[]).map((f) => (
            <NumberSetting key={f} field={f} value={data[f]} busy={busy} onSave={(field, n) => patch({ [field]: n })} />
          ))}
        </>
      )}
    </CollapsibleCard>
  );
}
