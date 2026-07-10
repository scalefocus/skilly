// CSP violation report sink (SKILLY_SPEC.md §22). Browsers POST here when a resource is blocked
// (or would be, under Content-Security-Policy-Report-Only). It is deliberately UNAUTHENTICATED —
// the browser sends no session — so it is bounded by a per-client-IP rate limit and a body-size
// cap, emits ONE structured log line, and bumps a counter. It NEVER writes audit_log (this is
// operational telemetry, not security provenance — invariant #5) and never echoes credentials or
// query strings (invariant #6): URI fields are logged with their query string / fragment stripped.
import { enforceRateLimit } from "../../../lib/ratelimit";
import { M } from "../../../lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 16 * 1024; // 16 KB — reports are tiny; refuse anything larger.

/** Best-effort originating client for rate-limit bucketing (behind the org proxy / Caddy). */
function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "anon";
  return req.headers.get("x-real-ip") || "anon";
}

/** Strip any query string / fragment so a URL can't smuggle a token into the log (invariant #6). */
function safeUri(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  return v.split(/[?#]/)[0]?.slice(0, 300);
}

export async function POST(req: Request): Promise<Response> {
  const limited = enforceRateLimit("csp-report", clientKey(req), 60);
  if (limited) return limited;

  // Fast reject oversized bodies by declared length; the read below is the authoritative cap.
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) return new Response(null, { status: 413 });

  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413 });

  // Two wire formats: legacy `{ "csp-report": {…} }` (application/csp-report) and the Reporting
  // API's `[ { type: "csp-violation", body: {…} }, … ]` (application/reports+json).
  let r: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const hit = parsed.find((x) => (x as { type?: string })?.type === "csp-violation") ?? parsed[0];
      r = ((hit as { body?: Record<string, unknown> })?.body ?? {}) as Record<string, unknown>;
    } else if (parsed && typeof parsed === "object") {
      r = ((parsed as Record<string, unknown>)["csp-report"] as Record<string, unknown>) ?? (parsed as Record<string, unknown>);
    } else {
      return new Response(null, { status: 400 });
    }
  } catch {
    return new Response(null, { status: 400 });
  }

  M.cspReports.inc();
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "csp-violation",
      // field names differ across the two report formats — capture whichever is present
      documentUri: safeUri(r["document-uri"] ?? r["documentURL"]),
      blockedUri: safeUri(r["blocked-uri"] ?? r["blockedURL"]),
      directive: r["effective-directive"] ?? r["effectiveDirective"] ?? r["violated-directive"] ?? null,
      disposition: r["disposition"] ?? null,
    }),
  );
  return new Response(null, { status: 204 });
}
