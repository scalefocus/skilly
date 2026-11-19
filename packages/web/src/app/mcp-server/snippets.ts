// SKILLY_SPEC.md §29 "The /mcp-server page" → Connect: every string the Connect card shows is built
// here from (server URL, scope), so the page only renders and the unit tests can pin each client's
// exact format. Pure — no React, no browser APIs.
//
// The formats are each vendor's own, checked 2026-11-19:
//   - Claude Code:  `claude mcp add --transport http --scope <local|user> <name> <url>`
//   - VS Code:      top-level `servers`, `type: "http"` (workspace .vscode/mcp.json or the user-profile file)
//   - Cursor:       top-level `mcpServers`, `url` only (.cursor/mcp.json or ~/.cursor/mcp.json)
//   - Claude Desktop / claude.ai: no file at all — a custom connector, added in the app (see the page).

/** The Connect card's scope toggle: "Every project" (`user`, the default) or "This project" (`local`). */
export type McpScope = "user" | "local";

/** Per-browser memory of the toggle (§29) — a viewer convenience, never sent to the server. */
export const MCP_SCOPE_KEY = "skilly.mcpScope";

/** skilly is an org-wide registry, so most people want it in every project. */
export const DEFAULT_MCP_SCOPE: McpScope = "user";

/** Read a stored scope; anything unknown (or nothing stored) falls back to "Every project". */
export function parseMcpScope(raw: string | null | undefined): McpScope {
  return raw === "local" ? "local" : DEFAULT_MCP_SCOPE;
}

/** A hint line as plain text plus inline `code` and **strong** runs, so the module stays JSX-free. */
export type HintPart = string | { code: string } | { strong: string };
export type Hint = HintPart[];

/** A hint flattened to its plain text (what a reader sees, minus the formatting). */
export function hintText(hint: Hint): string {
  return hint.map((p) => (typeof p === "string" ? p : "code" in p ? p.code : p.strong)).join("");
}

export interface ConnectSnippets {
  claudeCode: {
    /** Shown above the command — only for "This project". */
    hint: Hint | null;
    command: string;
    /** Shown under the command, for both scopes. */
    after: Hint;
  };
  vscode: { hint: Hint; json: string };
  cursor: { hint: Hint; json: string };
}

/** The server's name in every client's config. */
const NAME = "skilly";

export function connectSnippets(url: string, scope: McpScope): ConnectSnippets {
  const local = scope === "local";
  return {
    claudeCode: {
      // `--scope local` is spelled out rather than left to Claude Code's default, so the command says
      // what it does. The `project` scope (a team-shared .mcp.json) is deliberately not offered.
      hint: local ? ["Run it inside the project folder."] : null,
      command: `claude mcp add --transport http --scope ${scope} ${NAME} ${url}`,
      after: ["Then run ", { code: "/mcp" }, " in Claude Code, choose ", { strong: NAME }, " and sign in in the browser."],
    },
    vscode: {
      hint: local
        ? ["Save as ", { code: ".vscode/mcp.json" }, " in the workspace, or add the ", { code: NAME }, " entry to the existing file."]
        : ["Run ", { strong: "MCP: Open User Configuration" }, " from the Command Palette and add the ", { code: NAME }, " entry."],
      json: JSON.stringify({ servers: { [NAME]: { type: "http", url } } }, null, 2),
    },
    cursor: {
      hint: local
        ? ["Save as ", { code: ".cursor/mcp.json" }, " in the project, or add the ", { code: NAME }, " entry to the existing file."]
        : ["Save as ", { code: "~/.cursor/mcp.json" }, ", or add the ", { code: NAME }, " entry to the existing file."],
      // Cursor infers the remote transport from `url`; `type` is only for stdio servers.
      json: JSON.stringify({ mcpServers: { [NAME]: { url } } }, null, 2),
    },
  };
}

/**
 * Whether the URL can be a Claude custom connector at all: Claude connects from Anthropic's cloud
 * and needs HTTPS on port 443. Decided from the URL alone — whether the host is reachable from the
 * internet cannot be detected here, and is not attempted.
 */
export function connectorEligible(url: string): boolean {
  try {
    const u = new URL(url);
    // WHATWG URL normalises the scheme's default port to "", so `https://h:443` reads as "".
    return u.protocol === "https:" && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}
