// Rate limiters for the worker's HTTP surfaces — one per surface, so one surface's traffic never
// spends another's allowance (SKILLY_SPEC.md §22 "Rate limiting (worker HTTP surfaces)"):
//   - git smart server (§9): a per-IP flood guard on git paths only, plus a per-installation
//     bucket checked after authorization (gitTokenLimiter, applied inside git/server.ts);
//   - SCIM provisioning target (§5): its own per-IP limiter;
//   - everything else (the 404 fall-through): a fixed catch-all per-IP limiter.
// /healthz /readyz /metrics are deliberately EXEMPT — they mount before every limiter.
//
// Per-IP keys use the express-rate-limit default keyGenerator, which honors the app's `trust proxy`
// setting so the real client is counted behind the edge proxy. The IP limiters only read
// req.ip/headers and never consume the raw request stream the git backend reads. Per-instance
// (in-memory) only — the HA note (§14, build-plan #20) applies; a shared store is the next upgrade.
import rateLimit, { type RateLimitInfo } from "express-rate-limit";
import type { Request, RequestHandler, Response } from "express";
import { parseGitPath } from "./git/authorize.js";
import { M } from "./metrics.js";

/** Which limiter refused a request — the `surface` label on skilly_worker_rate_limited_total. */
export type RateSurface = "git_ip" | "git_token" | "scim" | "other";

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

/** Defaults per surface (§22). The env knobs below override all but `other`. */
export const RATE_DEFAULTS = {
  gitIp: { max: 600, windowMs: 60_000 },
  gitToken: { max: 300, windowMs: 15 * 60_000 },
  scim: { max: 600, windowMs: 60_000 },
  /** The catch-all for any other worker path — the previous app-wide default; not configurable. */
  other: { max: 100, windowMs: 15 * 60_000 },
} as const satisfies Record<string, RateLimitConfig>;

export interface WorkerRateLimits {
  gitIp: RateLimitConfig;
  gitToken: RateLimitConfig;
  scim: RateLimitConfig;
}

/**
 * Read one positive-integer knob. Unset/empty silently takes the default; a non-numeric, zero or
 * negative value also takes the default but warns, naming the variable (never echoing secrets —
 * these are plain numbers).
 */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, warn: (msg: string) => void): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw) && Number(raw) > 0 && Number.isSafeInteger(Number(raw))) return Number(raw);
  warn(`${name} must be a positive integer; using the default ${fallback}`);
  return fallback;
}

const warnLine = (msg: string) => console.warn(JSON.stringify({ level: "warn", msg }));

/** Resolve the configurable limits from env (§22 table). */
export function resolveWorkerRateLimits(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = warnLine): WorkerRateLimits {
  return {
    gitIp: {
      max: positiveInt(env, "GIT_IP_RATE_MAX", RATE_DEFAULTS.gitIp.max, warn),
      windowMs: positiveInt(env, "GIT_IP_RATE_WINDOW_MS", RATE_DEFAULTS.gitIp.windowMs, warn),
    },
    gitToken: {
      max: positiveInt(env, "GIT_TOKEN_RATE_MAX", RATE_DEFAULTS.gitToken.max, warn),
      windowMs: positiveInt(env, "GIT_TOKEN_RATE_WINDOW_MS", RATE_DEFAULTS.gitToken.windowMs, warn),
    },
    scim: {
      max: positiveInt(env, "SCIM_RATE_MAX", RATE_DEFAULTS.scim.max, warn),
      windowMs: positiveInt(env, "SCIM_RATE_WINDOW_MS", RATE_DEFAULTS.scim.windowMs, warn),
    },
  };
}

/** The shared 429 response: metric bump + short plain-text body (Retry-After is already set). */
function sendLimited(res: Response, surface: RateSurface, retryAfterSeconds: number): void {
  M.workerRateLimited.inc({ surface });
  res.status(429).type("text/plain").send(`rate limit exceeded — retry in ${retryAfterSeconds} s`);
}

/**
 * A per-IP limiter for one surface. Headers follow IETF draft-8, so `RateLimit-Policy` and
 * `RateLimit` name the bucket (e.g. `"scim"; q=600; w=60; pk=…`); a 429 also carries `Retry-After`.
 */
function ipLimiter(surface: RateSurface, cfg: RateLimitConfig, skip?: (req: Request) => boolean): RequestHandler {
  return rateLimit({
    windowMs: cfg.windowMs,
    limit: cfg.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: surface,
    skip,
    handler: (req, res) => {
      const resetTime = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.resetTime?.getTime();
      const retry = resetTime ? Math.max(1, Math.ceil((resetTime - Date.now()) / 1000)) : Math.ceil(cfg.windowMs / 1000);
      sendLimited(res, surface, retry);
    },
  });
}

/** True for a git smart-HTTP request (skill or marketplace repo) — what the git router serves. */
function isGitRequest(req: Request): boolean {
  const url = new URL(req.url, "http://internal");
  return parseGitPath(url.pathname, url.searchParams) !== null;
}

/** Git per-IP flood guard: counts only git smart-HTTP requests, before authorization. */
export function gitIpRateLimiter(cfg: RateLimitConfig = RATE_DEFAULTS.gitIp): RequestHandler {
  return ipLimiter("git_ip", cfg, (req) => !isGitRequest(req));
}

/** SCIM's own per-IP limiter — mount it on the /scim/v2 path. */
export function scimRateLimiter(cfg: RateLimitConfig = RATE_DEFAULTS.scim): RequestHandler {
  return ipLimiter("scim", cfg);
}

/** The catch-all for every other worker path (mounted after the git, SCIM and health handlers). */
export function workerRateLimiter(cfg: RateLimitConfig = RATE_DEFAULTS.other): RequestHandler {
  return ipLimiter("other", cfg);
}

export interface TokenRateDecision {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket's window resets (≥ 1). */
  resetSeconds: number;
}

/**
 * The git per-installation bucket (§22): a fixed window per install token, keyed by the token's
 * ROW ID — never the raw token, so no credential is held in limiter memory (invariant #6).
 * Checked by the git server only after a request is authorized.
 */
export class GitTokenLimiter {
  readonly max: number;
  readonly windowMs: number;
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(cfg: RateLimitConfig = RATE_DEFAULTS.gitToken, private readonly now: () => number = Date.now) {
    this.max = cfg.max;
    this.windowMs = cfg.windowMs;
  }

  /** Record one request for `tokenId` and decide whether it's within the bucket. */
  hit(tokenId: string): TokenRateDecision {
    const now = this.now();
    this.sweep(now);
    let w = this.windows.get(tokenId);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(tokenId, w);
    }
    const resetSeconds = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
    if (w.count >= this.max) return { ok: false, limit: this.max, remaining: 0, resetSeconds };
    w.count++;
    return { ok: true, limit: this.max, remaining: this.max - w.count, resetSeconds };
  }

  /**
   * Enforce the bucket for an authorized request: append this bucket to the draft-8 RateLimit
   * headers (after the git_ip guard's), and on exhaustion send the 429 and return false.
   */
  enforce(tokenId: string, res: Response): boolean {
    const d = this.hit(tokenId);
    appendHeader(res, "RateLimit-Policy", `"git_token"; q=${d.limit}; w=${Math.ceil(this.windowMs / 1000)}`);
    appendHeader(res, "RateLimit", `"git_token"; r=${d.remaining}; t=${d.resetSeconds}`);
    if (d.ok) return true;
    res.setHeader("Retry-After", String(d.resetSeconds));
    sendLimited(res, "git_token", d.resetSeconds);
    return false;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}

/** draft-8 RateLimit headers are lists — add our item after any the IP guard already set. */
function appendHeader(res: Response, name: string, item: string): void {
  const existing = res.getHeader(name);
  res.setHeader(name, existing ? `${String(existing)}, ${item}` : item);
}

/** Per-IP window + cap for the §29 MCP and OAuth surfaces. */
export const MCP_IP_RATE_WINDOW_MS = 60 * 1000;
export const MCP_IP_RATE_MAX = Number(process.env.MCP_IP_RATE_MAX ?? 600);

/**
 * Per-IP limiter for the MCP + OAuth mounts.
 *
 * Those mounts are limited separately from the git and SCIM limiters, which are sized for clones
 * and provisioning, not a working agent. But "separate" must not mean "unbounded": an
 * UNAUTHENTICATED caller never reaches the per-user buckets in mcp/rateLimit.ts (those key on the
 * resolved user), so without this a flood of 401s or token exchanges from one host would be
 * uncapped. The ceiling here is deliberately generous — it is a flood guard, not the real quota;
 * the per-user and per-(user, client) buckets are the quota.
 */
export function mcpIpRateLimiter(opts: { windowMs?: number; max?: number } = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? MCP_IP_RATE_WINDOW_MS,
    limit: opts.max ?? MCP_IP_RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });
}
