"use client";
// Administration → Email notifications → Email digests (SKILLY_SPEC.md §48.11): the kill switch,
// the organization-default frequency, the send hour and weekly day, and which types go into
// digests. Shown whatever the transport status — digests simply don't go out while email is down.
// Every change saves at once through PATCH /api/admin/settings (platform admin, audited per key).
import { useState, type CSSProperties, type ReactNode } from "react";
import { Switch, useApi } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import {
  DIGEST_DEFAULT_TYPES,
  DIGEST_FLOOR_LABELS,
  DIGEST_MODE_LABELS,
  DIGEST_MODES,
  DIGEST_TYPE_GROUPS,
  DIGEST_WEEKDAY_NAMES,
  formatDigestHour,
  type DigestMode,
} from "@skilly/shared/email-digest";

interface DigestSettingsView {
  emailDigestsEnabled: boolean;
  emailDigestDefaultMode: DigestMode;
  emailDigestHour: number;
  emailDigestWeekday: number;
  emailDigestTypes: string[];
}

const SELECT_STYLE: CSSProperties = { width: "100%", padding: "8px 34px 8px 10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 13.5 };

function Select({ label, value, onChange, disabled, children, caption }: { label: string; value: string | number; onChange: (v: string) => void; disabled: boolean; children: ReactNode; caption?: string }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
      <span style={{ minWidth: 150, fontWeight: 600, fontSize: 13.5 }}>{label}</span>
      <span className="select-wrap" style={{ width: 220, maxWidth: "100%" }}>
        <select style={SELECT_STYLE} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          {children}
        </select>
        <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
      {caption && <span className="muted" style={{ fontSize: 12 }}>{caption}</span>}
    </label>
  );
}

export function EmailDigestSettings() {
  const { data, reload } = useApi<DigestSettingsView>("/api/admin/settings");
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: Partial<DigestSettingsView>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) setError(String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${r.status})`));
      reload();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius-sm)", marginTop: 20 }} />;
  const types = new Set(data.emailDigestTypes);
  const toggleType = (t: string, on: boolean) => {
    const next = new Set(types);
    if (on) next.add(t);
    else next.delete(t);
    void patch({ emailDigestTypes: [...next] });
  };
  const isDefaultTypes = data.emailDigestTypes.length === DIGEST_DEFAULT_TYPES.length && DIGEST_DEFAULT_TYPES.every((t) => types.has(t));

  return (
    <section style={{ marginTop: 24 }} data-testid="email-digest-settings">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 4px" }}>Email digests</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        People can choose a daily or weekly summary email instead of one email per update. Only email is batched — the
        in-app inbox and the webhook are unchanged. Switching digests off keeps everyone&rsquo;s choice for later.
      </p>
      {error && <div style={{ fontSize: 13, color: "var(--danger)", marginBottom: 10 }}>{error}</div>}
      <Switch label="Allow email digests" checked={data.emailDigestsEnabled} disabled={busy} onChange={(next) => void patch({ emailDigestsEnabled: next })} style={{ marginBottom: 12 }} />
      <Select label="Default frequency" value={data.emailDigestDefaultMode} disabled={busy} onChange={(v) => void patch({ emailDigestDefaultMode: v as DigestMode })}>
        {DIGEST_MODES.map((m) => <option key={m} value={m}>{DIGEST_MODE_LABELS[m]}</option>)}
      </Select>
      <Select label="Send time" value={data.emailDigestHour} disabled={busy} onChange={(v) => void patch({ emailDigestHour: Number(v) })} caption="in each person's own time zone">
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatDigestHour(h, fmt.style)}</option>)}
      </Select>
      <Select label="Weekly digest day" value={data.emailDigestWeekday} disabled={busy} onChange={(v) => void patch({ emailDigestWeekday: Number(v) })}>
        {DIGEST_WEEKDAY_NAMES.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
      </Select>

      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "16px 0 6px", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>What goes into digests</span>
        <button type="button" className="btn btn-sm" disabled={busy || isDefaultTypes} onClick={() => void patch({ emailDigestTypes: [...DIGEST_DEFAULT_TYPES] })}>
          Reset to defaults
        </button>
      </div>
      {DIGEST_TYPE_GROUPS.map((g) => (
        <fieldset key={g.title} style={{ border: "none", padding: 0, margin: "0 0 10px" }}>
          <legend className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{g.title}</legend>
          {g.types.map((t) => (
            <label key={t.type} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, padding: "2px 0" }}>
              <input type="checkbox" checked={types.has(t.type)} disabled={busy} onChange={(e) => toggleType(t.type, e.target.checked)} />
              {t.label}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="muted" style={{ fontSize: 12.5 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>Always sent right away</div>
        {DIGEST_FLOOR_LABELS.join(" · ")}
      </div>
    </section>
  );
}
