// Per-tool rate limiting for the §29 MCP server.
//
// Two buckets are checked for every call — per USER and per (USER, CLIENT) — so one misbehaving
// agent can't consume its user's whole allowance, and a user running three agents still can't
// exceed their own ceiling. WRITES are held to the SAME per-minute limits the equivalent web route
// already enforces (see the table below): an agent gets no more proposal throughput than a person.
//
// Fixed-window, in-memory, per-instance — the same posture (and the same documented HA caveat,
// §14/§16 #20) as the web tier's limiter. A shared store is the next upgrade, not a v1 requirement.
import type { McpToolName } from "@skilly/shared";

interface Window {
  count: number;
  resetAt: number;
}
const windows = new Map<string, Window>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
}

function hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSeconds: number } {
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

/** Drop all windows (tests). */
export function resetMcpRateLimits(): void {
  windows.clear();
  lastSweep = 0;
}

/**
 * Per-minute ceilings, per tool. Writes deliberately mirror their web counterparts:
 *   install_skill → `install` (30) · propose_* → `proposals`/`uploads` (30/20) ·
 *   request_skill → `requests` (10) · rate_skill → `rating` (60) ·
 *   post_* → `messages` (60) · revise/resubmit → `proposal-action` (60) ·
 *   list_upstream_refs → `pointer-refs` (30).
 * Reads are generous but bounded — a working agent reads a lot more than a person clicks.
 */
const LIMITS: Record<McpToolName, number> = {
  // Core read
  search_skills: 120,
  get_skill: 240,
  get_skill_content: 120,
  list_skill_files: 120,
  get_skill_file: 240,
  get_registry_metadata: 60,
  // Install
  install_skill: 30,
  list_installed_skills: 60,
  uninstall_skill: 30,
  reactivate_install: 30,
  // Propose
  check_duplicate: 60,
  list_upstream_refs: 30,
  propose_pointer_skill: 30,
  propose_hosted_skill: 20,
  list_my_proposals: 60,
  get_proposal: 120,
  revise_proposal: 60,
  resubmit_proposal: 60,
  post_proposal_message: 60,
  // Social
  rate_skill: 60,
  get_skill_discussion: 120,
  post_skill_comment: 60,
  list_skill_requests: 60,
  request_skill: 10,
};

/** A resource read (the `resources/read` JSON-RPC method) shares the content-read ceiling. */
export const RESOURCE_READ_LIMIT = 240;

/** The JSON-RPC envelope itself, per user — bounds `initialize`/`tools/list` chatter too. */
export const RPC_ENVELOPE_LIMIT = 600;

export interface McpRateDecision {
  ok: boolean;
  retryAfterSeconds: number;
}

/**
 * Check both buckets for an operation. `op` is a tool name, `resources/read`, or `rpc` for the
 * envelope check. The per-client bucket gets the same ceiling as the per-user one: it exists to
 * stop ONE client monopolizing the allowance, not to grant more of it.
 */
export function checkMcpLimit(op: string, userId: string, clientDbId: string, limit: number): McpRateDecision {
  const user = hit(`mcp:${op}:u:${userId}`, limit, 60_000);
  if (!user.ok) return user;
  return hit(`mcp:${op}:uc:${userId}:${clientDbId}`, limit, 60_000);
}

/** The per-minute ceiling for a tool (falls back to a conservative value for an unknown name). */
export function toolLimit(tool: string): number {
  return (LIMITS as Record<string, number | undefined>)[tool] ?? 30;
}
