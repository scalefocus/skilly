"use client";
// §29 the MCP page: how a user connects an agent to this registry, and the list of connections they
// can revoke. Reachable from the account menu, above "Installed skills" — any authenticated user,
// since consumption is universal.
//
// Note what is NOT on this page: a credential. The client registers itself and the user completes
// the browser consent leg, so no snippet here ever contains a token — a genuine improvement on the
// §23 install command, which does leak into shell history and committed config.
import { useState } from "react";
import Link from "next/link";
import { useApi, EmptyState, Pill, ScrollToTop, CopyCommand } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";

interface Connection {
  grantId: string;
  clientName: string;
  clientUri: string | null;
  authorizedAt: string;
  lastUsedAt: string | null;
  blocked: boolean;
}
interface McpInfo {
  enabled: boolean;
  serverUrl: string;
  connections: Connection[];
}

// A labelled connect snippet. The copy affordance lives INSIDE the box and the whole box is the
// click target — the same component (and the same "✓ Copied" toast) as §23's install-command row,
// so the two surfaces cannot drift apart. No `$` prompt on either field: one of them is JSON.
function Snippet({ label, code, ariaLabel }: { label: string; code: string; ariaLabel: string }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <CopyCommand command={code} prompt={false} pin ariaLabel={ariaLabel} />
    </div>
  );
}

function McpInner() {
  const fmt = useDateFmt();
  const { data, loading, reload } = useApi<McpInfo>("/api/mcp/connections");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const url = data?.serverUrl ?? "";

  const revoke = async (c: Connection) => {
    if (!window.confirm(`Revoke ${c.clientName}? It will lose access immediately and have to be reconnected.`)) return;
    setBusy(c.grantId);
    setMsg(null);
    try {
      const r = await fetch(`/api/mcp/connections/${c.grantId}`, { method: "DELETE" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Failed to revoke");
      setMsg({ kind: "ok", text: "Revoked." });
      reload();
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <h1>MCP server</h1>
        <p className="page-sub">
          Connect a coding agent straight to this registry: it can search the catalog, read a skill&rsquo;s
          instructions live, and get an install command to run — all with exactly your permissions.
        </p>
      </div>

      {data && !data.enabled && (
        <div className="card reveal" style={{ padding: 16, marginBottom: 18, borderColor: "var(--warn-line, var(--line))" }}>
          <strong style={{ fontSize: 14 }}>The MCP server is switched off</strong>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: "6px 0 0", lineHeight: 1.6 }}>
            A platform administrator has disabled it for this registry. Existing connections are kept — nothing was
            revoked — and everything resumes if it is switched back on. You can still revoke connections below.
          </p>
        </div>
      )}

      <section className="card reveal" style={{ padding: 18, marginBottom: 18, display: "grid", gap: 14 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Connect an agent</h2>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0, lineHeight: 1.6 }}>
            Add the server to your client, then approve the connection in the browser window it opens. No token or secret
            goes into your config — you sign in with Entra ID and consent once.
          </p>
        </div>
        {/* Not until the server URL has actually arrived: a snippet rendered mid-fetch would carry an
            empty URL, and the whole box being click-to-copy makes pasting that truncated command easy. */}
        {url ? (
          <>
            <Snippet
              label="Claude Code"
              code={`claude mcp add --transport http skilly ${url}`}
              ariaLabel="Copy the Claude Code command"
            />
            <Snippet
              label="Claude Desktop / VS Code (mcp.json)"
              code={JSON.stringify({ mcpServers: { skilly: { type: "http", url } } }, null, 2)}
              ariaLabel="Copy the mcp.json configuration"
            />
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>Loading&hellip;</p>
        )}
        <p style={{ fontSize: 12.5, color: "var(--faint)", margin: 0, lineHeight: 1.6 }}>
          Server URL: <code style={{ fontFamily: "var(--font-mono)" }}>{url}</code>
        </p>
      </section>

      <section className="card reveal" style={{ padding: 18, marginBottom: 18 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>What a connected agent can do</h2>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>It can</div>
            <ul style={{ margin: 0, padding: "0 0 0 18px", fontSize: 13, lineHeight: 1.7, color: "var(--muted)" }}>
              <li>search and read skills you can already see</li>
              <li>read a skill&rsquo;s files without installing it</li>
              <li>mint install commands for you to run</li>
              <li>submit proposals, comments, ratings and requests as you</li>
            </ul>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>It cannot</div>
            <ul style={{ margin: 0, padding: "0 0 0 18px", fontSize: 13, lineHeight: 1.7, color: "var(--muted)" }}>
              <li>approve or reject proposals</li>
              <li>administer the platform or change settings</li>
              <li>delete skills, proposals or user data</li>
              <li>see anything your account can&rsquo;t</li>
            </ul>
          </div>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "12px 0 0", lineHeight: 1.6 }}>
          Anything an agent creates is labelled <em>via MCP</em> wherever people read it, so reviewers can tell.
        </p>
      </section>

      <section className="card reveal" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Connections</h2>
          <Link href="/installed" style={{ fontSize: 12.5 }}>
            Installed skills →
          </Link>
        </div>
        {msg && (
          <p style={{ fontSize: 13, margin: "0 0 10px", color: msg.kind === "ok" ? "var(--ok, var(--muted))" : "var(--danger, crimson)" }}>
            {msg.text}
          </p>
        )}
        {loading && <p style={{ fontSize: 13, color: "var(--faint)" }}>Loading…</p>}
        {!loading && (data?.connections.length ?? 0) === 0 && (
          <EmptyState title="No connected agents yet" hint="Add the server to a client using one of the snippets above; it will appear here once you approve it." />
        )}
        <div style={{ display: "grid", gap: 10 }}>
          {(data?.connections ?? []).map((c) => (
            <div
              key={c.grantId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 12px",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-sm)",
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
                  {c.clientName}
                  {c.blocked && <Pill tone="danger">blocked by an admin</Pill>}
                </div>
                <div style={{ fontSize: 12, color: "var(--faint)", marginTop: 2 }}>
                  authorized {fmt.dateTime(c.authorizedAt)}
                  {c.lastUsedAt ? ` · last used ${fmt.dateTime(c.lastUsedAt)}` : " · never used"}
                </div>
              </div>
              <button type="button" className="btn btn-sm" disabled={busy === c.grantId} onClick={() => revoke(c)}>
                {busy === c.grantId ? "Revoking…" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "12px 0 0", lineHeight: 1.6 }}>
          Revoking a connection cuts the agent off immediately. Skills it installed for you stay installed — manage those
          on <Link href="/installed">Installed skills</Link>.
        </p>
      </section>
    </div>
  );
}

export default function McpPage() {
  return (
    <RequireAuth>
      <McpInner />
    </RequireAuth>
  );
}
