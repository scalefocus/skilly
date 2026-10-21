// e2e/budget.ts: the CI per-test and per-assertion budgets scale with the worker count
// (SKILLY_SPEC.md §16 item 18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciBudget, ONE_WORKER_EXPECT_MS, ONE_WORKER_TEST_MS } from "./budget";

test("one worker keeps the one-worker budgets (GitHub Actions, a local CI=1 run)", () => {
  assert.deepEqual(ciBudget(1), { test: ONE_WORKER_TEST_MS, expect: ONE_WORKER_EXPECT_MS });
  assert.deepEqual(ciBudget(1), { test: 90_000, expect: 15_000 });
});

test("the default four Jenkins workers double both budgets", () => {
  assert.deepEqual(ciBudget(4), { test: 180_000, expect: 30_000 });
});

test("the scale is linear in the extra workers: a third more per worker", () => {
  assert.deepEqual(ciBudget(2), { test: 120_000, expect: 20_000 });
  assert.deepEqual(ciBudget(7), { test: 270_000, expect: 45_000 });
  assert.deepEqual(ciBudget(16), { test: 540_000, expect: 90_000 });
});

test("a worker count outside 1–16 is refused, like E2E_WORKERS itself", () => {
  for (const n of [0, 17, 1.5, Number.NaN]) assert.throws(() => ciBudget(n), /whole number from 1 to 16/);
});
