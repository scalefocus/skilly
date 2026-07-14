// Rate-limit middleware tests (SKILLY_SPEC.md §22). Verifies the app-wide limiter allows requests
// up to the limit then 429s, emits standard RateLimit headers + Retry-After, shares one counter
// across every path (git/SCIM/health) since it keys on client IP alone, and that the production
// defaults are the express-rate-limit example values.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { workerRateLimiter, WORKER_RATE_MAX, WORKER_RATE_WINDOW_MS } from "./rateLimit.js";

// One app + one limiter instance (so the in-memory counter persists across requests). A short
// window and a small max keep the test fast while exercising the real middleware.
function appWith(max: number) {
  const a = express();
  a.use(workerRateLimiter({ max, windowMs: 60_000 }));
  a.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  a.get("/scim/v2/Users", (_req, res) => res.json({ ok: true }));
  return a;
}

test("allows requests up to the limit, then 429s with a Retry-After header", async () => {
  const a = appWith(3);
  for (let i = 0; i < 3; i++) await request(a).get("/healthz").expect(200);
  const blocked = await request(a).get("/healthz").expect(429);
  assert.ok(Number(blocked.headers["retry-after"]) >= 1, "429 carries a Retry-After header");
});

test("emits standard RateLimit-* headers and drops legacy X-RateLimit-*", async () => {
  const res = await request(appWith(5)).get("/healthz").expect(200);
  assert.ok(
    res.headers["ratelimit-limit"] ?? res.headers["ratelimit"],
    "expected a standard RateLimit header",
  );
  assert.equal(res.headers["x-ratelimit-limit"], undefined);
});

test("one app-wide counter is shared across every path (git/SCIM/health)", async () => {
  const a = appWith(2);
  await request(a).get("/healthz").expect(200);
  await request(a).get("/scim/v2/Users").expect(200);
  // A third request on ANY path is over the shared per-IP budget — health is not exempt.
  await request(a).get("/scim/v2/Users").expect(429);
});

test("production defaults match the express-rate-limit example (100 / 15 min)", () => {
  assert.equal(WORKER_RATE_MAX, 100);
  assert.equal(WORKER_RATE_WINDOW_MS, 15 * 60 * 1000);
});
