// Shared plumbing for the feedback-survey routes (SKILLY_SPEC.md §36.10).
import type { SurveyRollOptions } from "./survey";
import { enforceRateLimit } from "./ratelimit";
import { BUG_REPORT_RATE_PER_DAY, BUG_REPORT_RATE_PER_MIN } from "@skilly/shared/survey";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * §36.17 a bug report's own limits — 3 / min and 20 / day per user — never the survey cooldowns.
 * A 429 Response when either is exceeded, else null. A request turned away by the per-minute limit
 * doesn't count against the day.
 */
export function bugReportRateLimited(userId: string): Response | null {
  return (
    enforceRateLimit("bug-report", userId, BUG_REPORT_RATE_PER_MIN) ??
    enforceRateLimit("bug-report-day", userId, BUG_REPORT_RATE_PER_DAY, DAY_MS)
  );
}

/**
 * The dev-only forced-win seam for e2e (§36.14): with SKILLY_DEV_AUTH=1 — never set in production,
 * where instrumentation.ts refuses to boot with it — a request carrying
 * `x-skilly-test-survey-roll: win` always wins the roll. Every other request rolls for real.
 */
export function rollOptions(req: Request): SurveyRollOptions {
  if (process.env.SKILLY_DEV_AUTH === "1" && req.headers.get("x-skilly-test-survey-roll") === "win") return { rng: () => 0 };
  return {};
}

/** `canShow` from a JSON body: only an explicit `true` counts. */
export function readCanShow(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { canShow?: unknown }).canShow === true;
}
