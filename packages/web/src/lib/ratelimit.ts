// Lightweight in-memory fixed-window rate limiter, keyed by user + route.
//
// HA NOTE (SKILLY_SPEC.md §14): state is per-process, so with N web replicas the effective
// limit is N×limit and counters reset on deploy. This is an accepted v1 tradeoff: the most
// security-sensitive path it fronts — one-time install-token minting — is independently bounded
// (tokens are random, single-use, short-TTL, and scoped to one skill+version, §9/#6), so an
// N× minting rate still can't be abused. For true cluster-wide limiting, back this with a
// shared store (Redis) — drop-in behind the same enforceRateLimit signature.
import { M } from "./metrics";

interface Window {
  count: number;
  resetAt: number; // epoch ms
}
const windows = new Map<string, Window>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
}

export interface RateDecision {
  ok: boolean;
  retryAfterSeconds: number;
}

/** Record a hit for `key` and decide whether it's within `limit` per `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): RateDecision {
  const now = Date.now();
  sweep(now);
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (w.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
  w.count++;
  return { ok: true, retryAfterSeconds: 0 };
}

/**
 * Enforce a rate limit for a named route. Returns a 429 Response when exceeded (and bumps the
 * rate-limited metric), or null to proceed. `subject` is typically the user id (falls back to
 * "anon" for unauthenticated callers).
 */
export function enforceRateLimit(route: string, subject: string | null, limit: number, windowMs = 60_000): Response | null {
  const decision = rateLimit(`${route}:${subject ?? "anon"}`, limit, windowMs);
  if (decision.ok) return null;
  M.rateLimited.inc({ route });
  return Response.json(
    { error: "rate limit exceeded — slow down" },
    { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
  );
}
