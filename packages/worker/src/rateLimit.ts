// App-wide rate limiter for the worker's HTTP surfaces — the git smart server (§9), the SCIM
// provisioning target (§5), and the operational /healthz /readyz /metrics endpoints. Closes
// CodeQL js/missing-rate-limiting (CWE-307/400/770) on all three worker surfaces by capping
// request volume before any authorization or DB-touching handler runs.
// SKILLY_SPEC.md §22 "Rate limiting (worker HTTP surfaces)".
//
// Per-instance (in-memory store), keyed by client IP (the express-rate-limit default keyGenerator,
// which honors the app's `trust proxy` setting so the real client is counted behind the edge
// proxy). Mounted app-wide BEFORE the git handler and any body parser: it only reads req.ip/headers
// and never consumes the raw request stream the git backend reads. Per-instance only — the HA note
// (§14, build-plan #20) applies; a shared store (Redis) is the next upgrade.
import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

/** Window length in ms — the express-rate-limit example default (15 minutes). */
export const WORKER_RATE_WINDOW_MS = 15 * 60 * 1000;
/** Max requests per window per client IP — the express-rate-limit example default. */
export const WORKER_RATE_MAX = 100;

/**
 * Build the worker's app-wide rate-limit middleware. Production mounts it with no args (the
 * express-rate-limit example limits: 100 requests / 15 min per IP). The optional overrides exist
 * only so tests can exercise the limit cheaply — production behavior is the exported defaults.
 */
export function workerRateLimiter(opts: { windowMs?: number; max?: number } = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? WORKER_RATE_WINDOW_MS,
    limit: opts.max ?? WORKER_RATE_MAX,
    standardHeaders: true, // emit RateLimit-* headers (+ Retry-After on 429)
    legacyHeaders: false, // drop the deprecated X-RateLimit-* headers
  });
}
