// Prometheus metrics for the web process. Optionally protected by METRICS_TOKEN (bearer);
// otherwise open for scraping on the internal network. SKILLY_SPEC.md §14.
import { metrics, METRICS_CONTENT_TYPE, constantTimeEqual } from "@skilly/shared";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const required = process.env.METRICS_TOKEN;
  // Fail closed in production: an unset token must NOT silently expose metrics publicly
  // (audit P1). Unauthenticated scraping is allowed only outside production (dev/local).
  if (!required) {
    if (process.env.NODE_ENV === "production") return new Response("metrics disabled (set METRICS_TOKEN)", { status: 403 });
  } else {
    const auth = req.headers.get("authorization") ?? "";
    if (!constantTimeEqual(auth, `Bearer ${required}`)) return new Response("unauthorized", { status: 401 });
  }
  return new Response(metrics.render(), { status: 200, headers: { "content-type": METRICS_CONTENT_TYPE } });
}
