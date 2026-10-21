// Per-test and per-assertion budgets for a CI e2e run (SKILLY_SPEC.md §16 item 18).
//
// The Jenkins run drives E2E_WORKERS Playwright workers against ONE `next dev`, whose single Node
// process renders every page and answers every API call. A journey's wall-clock therefore grows
// with the number of workers driving the server at the same time: on the Jenkins agent the longest
// one-worker test ran ~55 s, while on four workers the group journeys (content-risk, icon,
// already-installed) ran 80–90 s and timed out at the one-worker budget of 90 s. The budgets below
// are sized for one worker and scaled by `1 + (workers − 1) / 3`: ×1 on one worker (GitHub
// Actions, a local CI=1 run), ×2 on the default four, ×3 on seven. A test that needs more than
// that is a slow test, not a budget problem.

/** The per-test timeout on one worker. */
export const ONE_WORKER_TEST_MS = 90_000;
/** The per-assertion (`expect`) timeout on one worker. */
export const ONE_WORKER_EXPECT_MS = 15_000;

/** The per-test and per-assertion timeouts for a CI run with `workers` Playwright workers (1–16). */
export function ciBudget(workers: number): { test: number; expect: number } {
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    throw new Error(`workers must be a whole number from 1 to 16 (got ${workers})`);
  }
  const factor = 1 + (workers - 1) / 3;
  return { test: Math.round(ONE_WORKER_TEST_MS * factor), expect: Math.round(ONE_WORKER_EXPECT_MS * factor) };
}
