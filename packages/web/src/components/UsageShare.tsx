"use client";
// Usage insights — the consumer-side consent pieces (SKILLY_SPEC.md §68.4): the "Share usage" tick
// on the marketplace add panel (both surfaces), the one-time key block that follows a mint, and the
// Usage sharing card on My marketplaces. The raw key is shown exactly once; afterwards only its
// state (sharing since, last report) is known.
import { useState } from "react";
import { useApi } from "./ui";
import { CopyLine } from "./CopyLine";
import { useDateFmt } from "./DateFormat";

/** `usageKey` in a mint response (§68.8) — the raw key, its variable name and the paste-ready fragment. */
export interface MintedUsageKey {
  key: string;
  envVar: string;
  snippet: string;
  createdAt: string;
}

/** `usageSharing` on `GET /api/marketplaces` (§68.8). */
export interface UsageSharingState {
  enabled: boolean;
  envVar: string;
  key: { createdAt: string; lastUsedAt: string | null } | null;
}

/** The caller's sharing state, shared by every surface that renders the tick or the card. */
export function useUsageSharing(): { state: UsageSharingState | null; reload: () => void } {
  const { data, reload } = useApi<{ usageSharing?: UsageSharingState }>("/api/marketplaces");
  return { state: data?.usageSharing ?? null, reload };
}

export const SHARE_USAGE_COPY =
  "Claude Code will tell skilly which skills you use, how often, and whether you or Claude invoked them — never what you typed. Maintainers see counts only.";

/**
 * The "Share usage with skill maintainers" tick on the add panel's Generate step. Shown only while
 * the platform switch is on; a holder sees "You already share usage" instead (the key can't be
 * re-shown). Unticked by default — consent is an affirmative act (§68.1 decision 2).
 */
export function ShareUsageCheckbox({ state, checked, onChange, disabled }: { state: UsageSharingState | null; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  if (!state?.enabled) return null;
  if (state.key) {
    return (
      <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }} data-testid="share-usage-held">
        You already share usage — manage it in <a href="/marketplaces">My marketplaces</a>.
      </div>
    );
  }
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: 13, cursor: "pointer" }} data-testid="share-usage">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span>
        <span style={{ fontWeight: 600 }}>Share usage with skill maintainers</span>
        <span className="muted" style={{ display: "block", fontSize: 12 }}>{SHARE_USAGE_COPY}</span>
      </span>
    </label>
  );
}

/** The one-time key block under an add command (or on the card after Share / Regenerate). */
export function UsageKeyBlock({ usageKey }: { usageKey: MintedUsageKey }) {
  return (
    <div className="mk-usage-key" style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--line)" }} data-testid="usage-key-block">
      <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>Share usage</div>
      <CopyLine
        label={`Add to ~/.claude/settings.json (never the project's — settings files get committed)`}
        value={usageKey.snippet}
        hint={`Shown once. Needs node on your PATH. Enable auto-update for this marketplace (/plugin → Marketplaces) or run /plugin update so your plugins receive the reporting hook.`}
      />
    </div>
  );
}

/**
 * The Usage sharing card on My marketplaces (§68.4): Not sharing / Sharing since, last report, and
 * the Share usage / Regenerate key / Stop sharing actions. Absent while the platform switch is off.
 */
export function UsageSharingCard({ state, onChanged }: { state: UsageSharingState; onChanged: () => void }) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedUsageKey | null>(null);

  const call = async (path: string, method: "POST" | "DELETE") => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(path, { method });
      const j = (await r.json().catch(() => ({}))) as { usageKey?: MintedUsageKey; error?: string };
      if (!r.ok) throw new Error(j.error === "usage_key_exists" ? "You already hold a usage key." : (j.error ?? `Failed (${r.status})`));
      setMinted(j.usageKey ?? null);
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    if (!window.confirm("Stop sharing usage?\n\nYour Claude Code plugins will stop reporting. Counts already recorded stay.")) return;
    void call("/api/me/usage-key", "DELETE");
  };

  if (!state.enabled) return null;
  return (
    <section className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="usage-sharing-card">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, marginBottom: 2 }}>Usage sharing</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {state.key ? (
              <>
                <span style={{ color: "var(--ok)" }}>Sharing</span> since {fmt.date(state.key.createdAt)} ·{" "}
                {state.key.lastUsedAt ? `last report ${fmt.dateTime(state.key.lastUsedAt)}` : "no reports yet"}
              </>
            ) : (
              "Not sharing"
            )}
          </div>
        </div>
        <div className="version-actions">
          {state.key ? (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void call("/api/me/usage-key/regenerate", "POST")}>Regenerate key</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={stop}>Stop sharing</button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void call("/api/me/usage-key", "POST")}>Share usage</button>
          )}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{SHARE_USAGE_COPY}</p>
      {err && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: "var(--danger)" }}>{err}</div>}
      {minted && state.key && <UsageKeyBlock usageKey={minted} />}
    </section>
  );
}
