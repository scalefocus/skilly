// §25 system-log telemetry for the MCP server. Reads are NOT audited (consistent with every other
// read surface) — failures land here instead, alongside the git gateway's
// `install_token_owner_inactive`, which is the precedent for a `source='worker'`, 401-bearing event.
//
// Two rules, both load-bearing:
//   - the CLIENT-FACING response never distinguishes why a credential failed; the reason exists
//     only in this log (so a holder of a leaked token learns nothing);
//   - credentials never appear here — no bearer token, no refresh token, no Authorization header,
//     and `path` never carries a query string.
import type { Pool } from "pg";

export type McpErrorCode =
  | "mcp_disabled"
  | "mcp_token_invalid"
  | "mcp_token_expired"
  | "mcp_refresh_reuse_detected"
  | "mcp_grant_revoked"
  | "mcp_client_blocked"
  | "mcp_rate_limited"
  | "mcp_owner_inactive"
  | "mcp_upload_too_large";

export interface McpEvent {
  errorCode: McpErrorCode;
  status: number;
  /** Matched route template, e.g. `/mcp` or `/oauth/token`. */
  route: string;
  /** Concrete path — never a query string. */
  path: string;
  /** One line, no stack. Must not contain a credential. */
  message: string;
  method?: string;
  /** The forensic subject when we know it (e.g. the owner of a refused token). */
  userId?: string | null;
}

/**
 * Fire-and-forget insert. A logging failure must never change the response the client sees, so
 * every error here is swallowed after being printed to stdout (which is the SIEM path anyway).
 */
export async function logMcpEvent(pool: Pool, e: McpEvent): Promise<void> {
  try {
    await pool.query(
      `insert into system_event
         (status, method, route, path, user_id, actor_name, actor_email, error_code, message, source)
       values ($1, $2, $3, $4, $5,
               (select display_name from users where id = $5),
               (select email from users where id = $5),
               $6, $7, 'worker')`,
      [
        e.status,
        (e.method ?? "POST").slice(0, 10),
        e.route.slice(0, 300),
        e.path.slice(0, 500),
        e.userId ?? null,
        e.errorCode,
        e.message.slice(0, 300),
      ],
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "mcp system_event insert failed", err: String(err instanceof Error ? err.message : err) }));
  }
}
