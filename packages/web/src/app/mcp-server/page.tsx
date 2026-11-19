"use client";
// §29 the MCP page: how a user connects an agent to this registry, and the list of connections they
// can revoke. Reachable from the account menu, above "Installed skills" — any authenticated user,
// since consumption is universal.
//
// Note what is NOT on this page: a credential. The client registers itself and the user completes
// the browser consent leg, so no snippet here ever contains a token — a genuine improvement on the
// §23 install command, which does leak into shell history and committed config.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useApi, EmptyState, Pill, ScrollToTop, CopyCommand } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";
import {
  connectSnippets,
  connectorEligible,
  DEFAULT_MCP_SCOPE,
  MCP_SCOPE_KEY,
  parseMcpScope,
  type Hint,
  type McpScope,
} from "./snippets";

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

// A copy field. The copy affordance lives INSIDE the box and the whole box is the click target —
// the same component (and the same "✓ Copied" toast) as §23's install-command row, so the two
// surfaces cannot drift apart. No `$` prompt on any field here: two are JSON, one is a bare URL.
function Snippet({ code, ariaLabel }: { code: string; ariaLabel: string }) {
  return <CopyCommand command={code} prompt={false} pin ariaLabel={ariaLabel} />;
}

// One client's block: its name, then whatever it needs (hints, a snippet, steps).
function Client({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

const hintStyle = { fontSize: 12.5, color: "var(--muted)", margin: 0, lineHeight: 1.6 } as const;
const codeStyle = { fontFamily: "var(--font-mono)" } as const;

// A hint line from snippets.ts: plain text with inline `code` and **strong** runs.
function HintLine({ hint }: { hint: Hint }) {
  return (
    <p style={hintStyle}>
      {hint.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : "code" in p ? (
          <code key={i} style={codeStyle}>
            {p.code}
          </code>
        ) : (
          <strong key={i}>{p.strong}</strong>
        ),
      )}
    </p>
  );
}

function McpInner() {
  const fmt = useDateFmt();
  const { data, loading, reload } = useApi<McpInfo>("/api/mcp/connections");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const url = data?.serverUrl ?? "";

  // Scope toggle (§29): Every project (default) or This project, remembered per browser. Read after
  // mount (no localStorage during SSR); blocked storage → Every project on every visit.
  const [scope, setScope] = useState<McpScope>(DEFAULT_MCP_SCOPE);
  useEffect(() => {
    try { setScope(parseMcpScope(window.localStorage.getItem(MCP_SCOPE_KEY))); } catch { /* storage blocked → Every project */ }
  }, []);
  const pickScope = (next: McpScope) => {
    setScope(next);
    try { window.localStorage.setItem(MCP_SCOPE_KEY, next); } catch { /* per-browser convenience only */ }
  };
  const snippets = connectSnippets(url, scope);

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

      <section className="card reveal" style={{ padding: 18, marginBottom: 18, display: "grid", gap: 16 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Connect an agent</h2>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0, lineHeight: 1.6 }}>
            Add the server to your client, then approve the connection in the browser window it opens. No token or secret
            goes into your config — you sign in with Entra ID and consent once.
          </p>
        </div>
        {/* One toggle for the three file-based clients (§29). Claude Desktop / claude.ai connectors are
            account-wide, so it does not apply there — that block says so. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Available in</span>
          <div className="sort-toggle" role="group" aria-label="Install scope">
            <button type="button" className={`sort-opt${scope === "user" ? " sort-on" : ""}`} aria-pressed={scope === "user"} onClick={() => pickScope("user")}>
              Every project
            </button>
            <button type="button" className={`sort-opt${scope === "local" ? " sort-on" : ""}`} aria-pressed={scope === "local"} onClick={() => pickScope("local")}>
              This project
            </button>
          </div>
          <span style={{ fontSize: 12.5, color: "var(--faint)" }}>Applies to Claude Code, VS Code and Cursor.</span>
        </div>
        {/* Not until the server URL has actually arrived: a snippet rendered mid-fetch would carry an
            empty URL, and the whole box being click-to-copy makes pasting that truncated command easy. */}
        {url ? (
          <>
            <Client title="Claude Code">
              {snippets.claudeCode.hint && <HintLine hint={snippets.claudeCode.hint} />}
              <Snippet code={snippets.claudeCode.command} ariaLabel="Copy the Claude Code command" />
              <HintLine hint={snippets.claudeCode.after} />
            </Client>

            {/* Not a file: Claude Desktop's config only launches local servers, so a remote one is a
                custom connector added in the app. Menu labels are Anthropic's (checked 2026-11-19). */}
            <Client title="Claude Desktop / claude.ai">
              {!connectorEligible(url) && (
                <p
                  role="note"
                  style={{
                    ...hintStyle,
                    color: "var(--ink)",
                    padding: "8px 10px",
                    border: "1px solid var(--warn)",
                    background: "var(--warn-soft)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  This registry&rsquo;s address can&rsquo;t be used as a Claude connector: connectors need HTTPS on port 443.
                  Use Claude Code, VS Code or Cursor instead.
                </p>
              )}
              <ol style={{ ...hintStyle, padding: "0 0 0 20px", display: "grid", gap: 6 }}>
                <li>
                  In Claude, open <strong>Customize → Connectors</strong> and choose <strong>+ Add → Add custom connector</strong>.
                </li>
                <li style={{ display: "grid", gap: 6 }}>
                  <span>
                    Name it <code style={codeStyle}>skilly</code>, paste the server URL, click <strong>Add</strong>, then{" "}
                    <strong>Connect</strong>, and approve in the browser.
                  </span>
                  <Snippet code={url} ariaLabel="Copy the server URL" />
                </li>
              </ol>
              <p style={hintStyle}>
                On Team and Enterprise plans, an organization Owner adds the connector under{" "}
                <strong>Organization settings → Connectors</strong>; you then find it under{" "}
                <strong>Customize → Connectors</strong> and click <strong>Connect</strong>.
              </p>
              <p style={{ ...hintStyle, color: "var(--faint)" }}>
                Claude connects to connectors from Anthropic&rsquo;s cloud, not from your computer, so this only works if the
                registry is reachable from the internet over HTTPS on port 443. Connectors apply to your whole Claude account,
                so the toggle above doesn&rsquo;t affect this one.
              </p>
            </Client>

            <Client title="VS Code">
              <HintLine hint={snippets.vscode.hint} />
              <Snippet code={snippets.vscode.json} ariaLabel="Copy the VS Code configuration" />
            </Client>

            <Client title="Cursor">
              <HintLine hint={snippets.cursor.hint} />
              <Snippet code={snippets.cursor.json} ariaLabel="Copy the Cursor configuration" />
            </Client>
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
