"use client";
// Administration → MCP server (§29). One master on/off toggle (ships ON), the two token lifetimes,
// and the registered-client list with a per-client block control.
//
// The toggle is a KILL-SWITCH, not a purge: switching MCP off leaves every grant, refresh token and
// registered client untouched — requests are simply refused with a clear message, and re-enabling
// resumes everything with no re-authorization. That is why there is no org-wide "revoke all" button
// here: a one-click mass purge's only outcome is re-onboarding the whole org. The per-client BLOCK
// below is the incident control, and a user can revoke their own connection on /mcp.
import { useState } from "react";
import { Pill, useApi } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { CollapsibleCard } from "./CollapsibleCard";

interface AdminClient {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  blocked: boolean;
  liveGrants: number;
}
interface McpStatus {
  enabled: boolean;
  accessTtlMinutes: number;
  refreshTtlDays: number;
  maxInlineUploadBytes: number;
  maxResourceBytes: number;
  serverUrl: string;
  liveGrants: number;
  clients: AdminClient[];
}

const field: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-body)",
  fontSize: 13,
  width: 90,
};

/** Bytes → a short MiB label for the placeholders. */
function mib(bytes: number | undefined): string {
  return bytes == null ? "" : String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}
/** An admin-entered MiB value → whole bytes (the setting is stored and validated in bytes). */
function toBytes(mbInput: string): number {
  return Math.round(Number(mbInput.trim()) * 1024 * 1024);
}

export function McpCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const fmt = useDateFmt();
  const { data, reload } = useApi<McpStatus>("/api/admin/mcp");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [accessTtl, setAccessTtl] = useState<string>("");
  const [refreshTtl, setRefreshTtl] = useState<string>("");
  const [inlineMb, setInlineMb] = useState<string>("");
  const [readMb, setReadMb] = useState<string>("");

  const patchSettings = async (body: Record<string, unknown>) => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      reload();
      setFlash({ tone: "ok", text: "Saved." });
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const block = async (c: AdminClient) => {
    const verb = c.blocked ? "Unblock" : "Block";
    if (!window.confirm(`${verb} ${c.clientName}? ${c.blocked ? "It will be able to connect again." : `Its ${c.liveGrants} live connection(s) will be refused, but not revoked.`}`)) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch(`/api/admin/mcp/clients/${c.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blocked: !c.blocked }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      reload();
      setFlash({ tone: "ok", text: `${verb}ed ${c.clientName}.` });
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const summary = data
    ? `${data.enabled ? "on" : "off"} · ${data.liveGrants} connection${data.liveGrants === 1 ? "" : "s"} · ${data.clients.length} client${data.clients.length === 1 ? "" : "s"}`
    : "…";

  return (
    <CollapsibleCard
      cardId="mcp"
      title="MCP server"
      summary={summary}
      accessory={data ? <Pill tone={data.enabled ? "ok" : "muted"}>{data.enabled ? "enabled" : "disabled"}</Pill> : null}
      open={open}
      onToggle={onToggle}
    >
      <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 12px" }}>
        Lets people connect a coding agent to this registry over the Model Context Protocol. Agents act as the
        signed-in user with exactly their permissions — they cannot approve proposals, administer the platform, or
        delete anything. Users connect from their own <a href="/mcp">MCP page</a>.
      </p>

      {flash && (
        <p style={{ fontSize: 13, margin: "0 0 12px", color: flash.tone === "ok" ? "var(--ok, var(--muted))" : "var(--danger, crimson)" }}>
          {flash.text}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !data}
          onClick={() => data && patchSettings({ mcpEnabled: !data.enabled })}
        >
          {data?.enabled ? "Switch off" : "Switch on"}
        </button>
        <span style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.5 }}>
          Switching off refuses every MCP request but <strong>keeps</strong> existing connections — nothing is revoked,
          and switching back on resumes them.
        </span>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 14 }}>
        <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
          Access-token lifetime (minutes)
          <span style={{ display: "flex", gap: 6 }}>
            <input
              style={field}
              inputMode="numeric"
              placeholder={String(data?.accessTtlMinutes ?? 60)}
              value={accessTtl}
              onChange={(e) => setAccessTtl(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || accessTtl.trim() === ""}
              onClick={() => patchSettings({ mcpAccessTtlMinutes: Number(accessTtl.trim()) }).then(() => setAccessTtl(""))}
            >
              Save
            </button>
          </span>
        </label>
        <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
          Refresh-token lifetime (days)
          <span style={{ display: "flex", gap: 6 }}>
            <input
              style={field}
              inputMode="numeric"
              placeholder={String(data?.refreshTtlDays ?? 90)}
              value={refreshTtl}
              onChange={(e) => setRefreshTtl(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || refreshTtl.trim() === ""}
              onClick={() => patchSettings({ mcpRefreshTtlDays: Number(refreshTtl.trim()) }).then(() => setRefreshTtl(""))}
            >
              Save
            </button>
          </span>
        </label>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 14 }}>
        <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
          Inline upload limit (MiB)
          <span style={{ display: "flex", gap: 6 }}>
            <input
              style={field}
              inputMode="decimal"
              placeholder={mib(data?.maxInlineUploadBytes)}
              value={inlineMb}
              onChange={(e) => setInlineMb(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || inlineMb.trim() === ""}
              onClick={() => patchSettings({ mcpMaxInlineUploadBytes: toBytes(inlineMb) }).then(() => setInlineMb(""))}
            >
              Save
            </button>
          </span>
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
            Bundles above this must be uploaded in the browser — base64 in a tool call can&rsquo;t carry a large one.
          </span>
        </label>
        <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
          Single-read limit (MiB)
          <span style={{ display: "flex", gap: 6 }}>
            <input
              style={field}
              inputMode="decimal"
              placeholder={mib(data?.maxResourceBytes)}
              value={readMb}
              onChange={(e) => setReadMb(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || readMb.trim() === ""}
              onClick={() => patchSettings({ mcpMaxResourceBytes: toBytes(readMb) }).then(() => setReadMb(""))}
            >
              Save
            </button>
          </span>
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
            The biggest SKILL.md or bundle file an agent may read in one call.
          </span>
        </label>
      </div>

      <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "0 0 14px", fontFamily: "var(--font-mono)" }}>
        {data?.serverUrl}
      </p>

      <div style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>Registered clients</div>
      {data && data.clients.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>
          None yet. Clients register themselves when someone first connects; a registration that never leads to a
          connection is pruned after 7 days.
        </p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {(data?.clients ?? []).map((c) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "8px 10px",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-sm)",
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                {c.clientName}
                {c.blocked && <Pill tone="danger">blocked</Pill>}
                {c.liveGrants > 0 && <Pill tone="muted">{c.liveGrants} connected</Pill>}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {c.clientId} · registered {fmt.date(c.createdAt)}
                {c.lastUsedAt ? ` · last used ${fmt.dateTime(c.lastUsedAt)}` : " · never used"}
              </div>
            </div>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => block(c)}>
              {c.blocked ? "Unblock" : "Block"}
            </button>
          </div>
        ))}
      </div>
    </CollapsibleCard>
  );
}
