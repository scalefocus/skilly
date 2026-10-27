"use client";
// Administration → Search → Search gaps (SKILLY_SPEC.md §62.8): the collection switch (off by
// default), how often the sweep runs, how many people make a gap, how far back it looks, Run now and
// the link to /admin/search-gaps. Saved through PATCH /api/admin/settings (platform admin; validated
// server-side, 422 shown inline; audited per key as settings.updated).
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  SEARCH_GAP_LOOKBACK_DAYS,
  SEARCH_GAP_MIN_SEARCHERS,
  SEARCH_GAP_SWEEP_HOURS,
  type IntRange,
  type SearchGapStatus,
} from "@skilly/shared/search-gaps";
import { Switch, useApi } from "../../components/ui";
import { useAiName } from "../../components/AiName";
import { useDateFmt } from "../../components/DateFormat";

interface Settings {
  searchGapsEnabled: boolean;
  searchGapsSweepHours: number;
  searchGapsMinSearchers: number;
  searchGapsLookbackDays: number;
}
type NumField = "searchGapsSweepHours" | "searchGapsMinSearchers" | "searchGapsLookbackDays";

const FIELDS: Record<NumField, IntRange & { label: string; unit: string; hint: string }> = {
  searchGapsSweepHours: { ...SEARCH_GAP_SWEEP_HOURS, label: "Run every", unit: "hours", hint: "How often the sweep groups searches into gaps and drafts suggestions." },
  searchGapsMinSearchers: { ...SEARCH_GAP_MIN_SEARCHERS, label: "Minimum people", unit: "people", hint: "A search becomes a gap once this many people made it (counted per day)." },
  searchGapsLookbackDays: { ...SEARCH_GAP_LOOKBACK_DAYS, label: "Look back", unit: "days", hint: "How many days of searches count toward a gap." },
};

function Spinner({ field, value, busy, onSave }: { field: NumField; value: number; busy: boolean; onSave: (f: NumField, n: number) => Promise<boolean> }) {
  const r = FIELDS[field];
  const saved = String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved && draft.trim() !== "";
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ minWidth: 140, fontWeight: 600, fontSize: 13.5 }}>{r.label}</span>
        <input
          type="number"
          min={r.min}
          max={r.max}
          step={1}
          aria-label={r.label}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) void onSave(field, Number(draft.trim())); }}
          className="input input-mono"
          style={{ width: 100 }}
          data-testid={`search-gaps-${field}`}
        />
        <span className="muted" style={{ fontSize: 13 }}>{r.unit}</span>
        <button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => void onSave(field, Number(draft.trim()))}>Save</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{r.hint} Whole number, {r.min}–{r.max}.</div>
    </div>
  );
}

export function SearchGapsSettings({ onEnabledChange }: { onEnabledChange?: (enabled: boolean) => void }) {
  const aiName = useAiName();
  const fmt = useDateFmt();
  const { data, reload } = useApi<Settings>("/api/admin/settings");
  const { data: gaps, reload: reloadGaps } = useApi<{ counts: { review: number }; status: SearchGapStatus }>("/api/admin/search-gaps?tab=review");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (data) onEnabledChange?.(data.searchGapsEnabled); }, [data, onEnabledChange]);

  const patch = async (body: Partial<Settings>): Promise<boolean> => {
    setBusy(true);
    const r = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { setErr(null); reload(); reloadGaps(); return true; }
    setErr(((await r?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Couldn't save. Try again.");
    return false;
  };

  const runNow = async () => {
    setBusy(true);
    const r = await fetch("/api/admin/search-gaps/run", { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!r?.ok) setErr(((await r?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Couldn't start a run.");
    else { setErr(null); reloadGaps(); }
  };

  const st = gaps?.status;
  return (
    <div style={{ marginTop: 26, paddingTop: 18, borderTop: "1px solid var(--line)" }} data-testid="search-gaps-settings">
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Search gaps</div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        What people search for and don&rsquo;t find, with no one&rsquo;s identity attached. Platform admins turn gaps into a
        synonym or a skill request on the <Link href="/admin/search-gaps">Search gaps</Link> page.
      </p>
      {data && (
        <>
          <div style={{ marginBottom: 6 }}>
            <Switch
              label="Collect searches that find nothing"
              checked={data.searchGapsEnabled}
              disabled={busy}
              onChange={(next) => void patch({ searchGapsEnabled: next })}
            />
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
            Keeps the text of searches that find nothing, without who searched. While {aiName} is available, the text is sent to the AI provider to draft suggestions.
          </p>
          {(Object.keys(FIELDS) as NumField[]).map((f) => (
            <Spinner key={f} field={f} value={data[f]} busy={busy} onSave={(field, n) => patch({ [field]: n })} />
          ))}
        </>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm" disabled={busy || !data?.searchGapsEnabled || st?.runRequested} onClick={() => void runNow()} data-testid="search-gaps-settings-run">
          {st?.runRequested ? "Run requested" : "Run now"}
        </button>
        <Link href="/admin/search-gaps" style={{ fontSize: 13 }}>Open search gaps ({gaps?.counts.review ?? 0})</Link>
        {st?.lastRun && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Last run {fmt.dateTime(st.lastRun.startedAt)}{st.lastRun.ok ? ` · ${st.lastRun.newGaps} new` : ` · failed: ${st.lastRun.error ?? "unknown error"}`}
          </span>
        )}
      </div>
      {err && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--danger)" }} data-testid="search-gaps-settings-error">{err}</div>}
    </div>
  );
}
