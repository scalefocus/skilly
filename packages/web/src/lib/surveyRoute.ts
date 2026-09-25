// Shared plumbing for the feedback-survey routes (SKILLY_SPEC.md §36.10).
import type { SurveyRollOptions } from "./survey";

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
