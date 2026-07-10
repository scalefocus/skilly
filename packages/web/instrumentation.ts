// Next.js startup hook (runs once at server boot, NOT at build time). Fail fast on missing
// required secrets in production rather than degrading silently at first use. SKILLY_SPEC.md §13.
export async function register(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  // Hard fail-safe: dev passwordless sign-in must NEVER run in production (CLAUDE.md "Don't").
  if (process.env.SKILLY_DEV_AUTH === "1") {
    throw new Error("[skilly] SKILLY_DEV_AUTH=1 is forbidden in production");
  }
  const required = ["DATABASE_URL", "NEXTAUTH_SECRET"];
  // Real SSO is required unless dev auth is explicitly enabled (which auth.ts forbids in prod).
  if (process.env.SKILLY_DEV_AUTH !== "1") {
    required.push("ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_TENANT_ID");
  }
  required.push("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET");
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`[skilly] missing required env in production: ${missing.join(", ")}`);
}

// Best-effort net for the System log (SKILLY_SPEC.md §25). PRIMARY capture is the withSystemLog
// wrapper (lib/apiLog.ts), which records both error responses AND thrown errors in the route's own
// context and is the reliable path. This hook only catches throws on routes that are NOT wrapped.
// It loads once at server boot (instrumentation does not hot-reload), so in dev it reflects only
// what existed at startup; in production it's present from boot. No overlap with the wrapper: a
// wrapped handler's throw is caught there and answered with a 500 (no propagation), so it never
// reaches this hook. Dynamic, nodejs-only import of the lean systemLog (pool-only, no next-auth)
// keeps pg out of the edge bundle and avoids a heavy transitive import here.
export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string; headers?: Record<string, string> },
  context: { routePath?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recordSystemEvent } = await import("./src/lib/systemLog");
    void recordSystemEvent({
      status: 500,
      method: request?.method ?? "GET",
      route: context?.routePath || request?.path || "unknown",
      path: request?.path ?? "",
      userId: null,
      errorCode: null,
      message: err instanceof Error ? err.message : String(err),
      requestId: request?.headers?.["x-request-id"] ?? null,
      durationMs: null,
    }).catch(() => {});
  } catch {
    /* logging must never break Next's own error reporting */
  }
}
