// Route wrapper for the System log (SKILLY_SPEC.md §25). Kept separate from systemLog.ts because
// it imports the session guard (next-auth) — which must NOT be pulled into instrumentation.ts.
//
// Why capture here rather than rely on instrumentation's onRequestError: that hook proved
// unreliable for thrown route-handler errors (it silently records nothing), so we catch in the
// route's OWN context where the pg pool and session are known-good. The wrapper records BOTH the
// error responses a handler returns AND errors it throws, then for a throw returns a JSON 500
// itself (no rethrow) so onRequestError can't also fire and double-count.
import { currentAccess } from "./guard";
import { recordSystemEvent, shouldRecord } from "./systemLog";

function pathOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "";
  }
}

// Pull the {error:"…"} string we already return, without consuming the real response body.
async function extractErrorCode(res: Response): Promise<string | null> {
  try {
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    const j = (await res.clone().json()) as unknown;
    const e = j && typeof j === "object" && "error" in j ? (j as { error?: unknown }).error : null;
    return typeof e === "string" ? e.slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function currentUserId(): Promise<string | null> {
  try {
    return (await currentAccess())?.userId ?? null;
  } catch {
    return null; // unauthenticated / no session
  }
}

/**
 * Wrap a Next route handler so its errors land in the System log.
 *
 * - Returned error responses (deliberate 4XX/5XX): recorded per shouldRecord().
 * - Thrown/uncaught errors: logged to stdout (preserve ops visibility), recorded as a 500, and
 *   answered with a JSON 500 — so the handler's throw never depends on onRequestError firing.
 *
 * The INSERT is always fire-and-forget (never awaited; a logging failure can't change the
 * response). The 2xx/3xx happy path short-circuits in shouldRecord and pays nothing.
 */
export function withSystemLog<C>(
  route: string,
  handler: (req: Request, ctx: C) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req: Request, ctx: C): Promise<Response> => {
    const started = Date.now();
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      // Keep the stdout log Next would otherwise emit (ops/log-aggregation rely on it).
      console.error(JSON.stringify({ level: "error", msg: "route handler threw", route, err: String(err instanceof Error ? (err.stack ?? err.message) : err) }));
      void recordSystemEvent({
        status: 500,
        method: req.method,
        route,
        path: pathOf(req),
        userId: await currentUserId(),
        errorCode: null,
        message: err instanceof Error ? err.message : String(err),
        requestId: req.headers.get("x-request-id"),
        durationMs: Date.now() - started,
      }).catch(() => {});
      return Response.json({ error: "internal error" }, { status: 500 });
    }

    const path = pathOf(req);
    if (shouldRecord(res.status, path)) {
      const errorCode = await extractErrorCode(res);
      void recordSystemEvent({
        status: res.status,
        method: req.method,
        route,
        path,
        userId: await currentUserId(),
        errorCode,
        message: res.status >= 500 ? errorCode : null,
        requestId: req.headers.get("x-request-id"),
        durationMs: Date.now() - started,
      }).catch(() => {});
    }
    return res;
  };
}
