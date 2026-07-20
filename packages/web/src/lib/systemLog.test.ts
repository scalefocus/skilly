// Tests for the System log recording tier (SKILLY_SPEC.md §25 "What is recorded").
// shouldRecord is pure; importing the module only constructs the (lazy) pg pool.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRecord } from "./systemLog";

test("shouldRecord: every 5XX is recorded", () => {
  assert.equal(shouldRecord(500, "/api/uploads"), true);
  assert.equal(shouldRecord(503, "/api/uploads"), true);
});

test("shouldRecord: the meaningful 4XX are recorded — 403/409/413/422/429", () => {
  for (const status of [403, 409, 413, 422, 429]) {
    assert.equal(shouldRecord(status, "/api/uploads"), true, `expected ${status} to be recorded`);
  }
});

test("shouldRecord: noise statuses are excluded — 401/404 and the happy path", () => {
  for (const status of [200, 201, 304, 400, 401, 404]) {
    assert.equal(shouldRecord(status, "/api/me"), false, `expected ${status} to be excluded`);
  }
});
