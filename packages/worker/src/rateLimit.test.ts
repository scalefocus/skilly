// Rate-limit tests (SKILLY_SPEC.md §22 "Rate limiting (worker HTTP surfaces)"). Covers the env
// knobs, each per-surface limiter on its own, their independence from one another, the health
// exemption (mounted ahead of every limiter, mirroring buildServer's order), the draft-8 headers
// that name each bucket, and the per-installation GitTokenLimiter.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  RATE_DEFAULTS,
  resolveWorkerRateLimits,
  gitIpRateLimiter,
  scimRateLimiter,
  workerRateLimiter,
  GitTokenLimiter,
} from "./rateLimit.js";
import { metrics } from "./metrics.js";

const GIT_REFS = "/team-a/pdf.git/info/refs?service=git-upload-pack";

/**
 * An app wired in buildServer's order with tiny limits: health first (exempt), then the git
 * per-IP guard, a stand-in git handler, SCIM behind its own limiter, then the catch-all.
 */
function appWith(max = { git: 2, scim: 2, other: 2 }) {
  const a = express();
  a.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  a.get("/readyz", (_req, res) => res.json({ status: "ready" }));
  a.get("/metrics", (_req, res) => res.type("text/plain").send("# metrics"));
  a.use(gitIpRateLimiter({ max: max.git, windowMs: 60_000 }));
  a.use((req, res, next) => (req.path.includes(".git/") ? res.type("text/plain").send("refs") : next()));
  a.use("/scim/v2", scimRateLimiter({ max: max.scim, windowMs: 60_000 }), (_req, res) => res.json({ ok: true }));
  a.use(workerRateLimiter({ max: max.other, windowMs: 60_000 }));
  return a;
}

test("defaults: git 600/min per IP + 300/15 min per installation, SCIM 600/min, catch-all 100/15 min", () => {
  assert.deepEqual(RATE_DEFAULTS.gitIp, { max: 600, windowMs: 60_000 });
  assert.deepEqual(RATE_DEFAULTS.gitToken, { max: 300, windowMs: 900_000 });
  assert.deepEqual(RATE_DEFAULTS.scim, { max: 600, windowMs: 60_000 });
  assert.deepEqual(RATE_DEFAULTS.other, { max: 100, windowMs: 900_000 });
});

test("env knobs override the defaults; unset/empty values fall back silently", () => {
  const warnings: string[] = [];
  const limits = resolveWorkerRateLimits(
    { GIT_IP_RATE_MAX: "1200", GIT_TOKEN_RATE_WINDOW_MS: "60000", SCIM_RATE_MAX: " 50 ", SCIM_RATE_WINDOW_MS: "" },
    (m) => warnings.push(m),
  );
  assert.deepEqual(limits, {
    gitIp: { max: 1200, windowMs: 60_000 },
    gitToken: { max: 300, windowMs: 60_000 },
    scim: { max: 50, windowMs: 60_000 },
  });
  assert.deepEqual(warnings, []);
});

test("invalid env values fall back to the default with one warning naming the variable", () => {
  const warnings: string[] = [];
  const limits = resolveWorkerRateLimits(
    { GIT_IP_RATE_MAX: "0", GIT_TOKEN_RATE_MAX: "-5", SCIM_RATE_MAX: "lots", SCIM_RATE_WINDOW_MS: "1.5" },
    (m) => warnings.push(m),
  );
  assert.equal(limits.gitIp.max, 600);
  assert.equal(limits.gitToken.max, 300);
  assert.equal(limits.scim.max, 600);
  assert.equal(limits.scim.windowMs, 60_000);
  assert.equal(warnings.length, 4);
  for (const name of ["GIT_IP_RATE_MAX", "GIT_TOKEN_RATE_MAX", "SCIM_RATE_MAX", "SCIM_RATE_WINDOW_MS"]) {
    assert.ok(warnings.some((w) => w.startsWith(name)), `warning names ${name}`);
  }
});

test("health/ops endpoints are never throttled", async () => {
  const a = appWith({ git: 1, scim: 1, other: 1 });
  for (let i = 0; i < 10; i++) {
    await request(a).get("/healthz").expect(200);
    await request(a).get("/readyz").expect(200);
    await request(a).get("/metrics").expect(200);
  }
  // …and they spend no other surface's budget.
  await request(a).get(GIT_REFS).expect(200);
  await request(a).get("/scim/v2/Users").expect(200);
});

test("git per-IP guard: allows up to the limit, then 429 with Retry-After, a plain-text body and the bucket named", async () => {
  const a = appWith();
  const ok = await request(a).get(GIT_REFS).expect(200);
  assert.match(String(ok.headers["ratelimit-policy"]), /"git_ip"; q=2; w=60;/);
  await request(a).get(GIT_REFS).expect(200);
  const blocked = await request(a).get(GIT_REFS).expect(429);
  assert.ok(Number(blocked.headers["retry-after"]) >= 1, "429 carries Retry-After");
  assert.match(blocked.text, /^rate limit exceeded — retry in \d+ s$/);
  assert.match(String(blocked.headers["content-type"]), /text\/plain/);
  assert.equal(blocked.headers["x-ratelimit-limit"], undefined, "no legacy X-RateLimit-* headers");
});

test("surfaces are independent: exhausting git leaves SCIM and the catch-all untouched", async () => {
  const a = appWith();
  await request(a).get(GIT_REFS).expect(200);
  await request(a).get(GIT_REFS).expect(200);
  await request(a).get(GIT_REFS).expect(429);
  const scim = await request(a).get("/scim/v2/Users").expect(200);
  assert.match(String(scim.headers["ratelimit-policy"]), /"scim"; q=2; w=60;/);
  await request(a).get("/scim/v2/Users").expect(200);
  await request(a).get("/scim/v2/Users").expect(429);
  // The catch-all (404 fall-through) has its own budget too.
  const other = await request(a).get("/nope").expect(404);
  assert.match(String(other.headers["ratelimit-policy"]), /"other"; q=2; w=60;/);
});

test("the git guard ignores non-git paths (they never spend the git budget)", async () => {
  const a = appWith({ git: 1, scim: 5, other: 5 });
  for (let i = 0; i < 3; i++) await request(a).get("/team-a/not-a-repo").expect(404);
  await request(a).get(GIT_REFS).expect(200);
});

test("each 429 bumps skilly_worker_rate_limited_total with its surface label", async () => {
  const a = appWith({ git: 1, scim: 1, other: 1 });
  await request(a).get("/scim/v2/Users").expect(200);
  await request(a).get("/scim/v2/Users").expect(429);
  assert.match(metrics.render(), /skilly_worker_rate_limited_total\{surface="scim"\} [1-9]/);
});

test("GitTokenLimiter: fixed window per token id, isolated between tokens, resets after the window", () => {
  let now = 1_000_000;
  const lim = new GitTokenLimiter({ max: 2, windowMs: 60_000 }, () => now);
  assert.deepEqual(lim.hit("t1"), { ok: true, limit: 2, remaining: 1, resetSeconds: 60 });
  assert.equal(lim.hit("t1").remaining, 0);
  const blocked = lim.hit("t1");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.resetSeconds, 60);
  assert.equal(lim.hit("t2").ok, true, "another installation has its own bucket");
  now += 60_000;
  assert.equal(lim.hit("t1").ok, true, "the window resets");
});

test("GitTokenLimiter.enforce appends the git_token bucket to the RateLimit headers and 429s when spent", async () => {
  const lim = new GitTokenLimiter({ max: 1, windowMs: 900_000 });
  const a = express();
  a.use(gitIpRateLimiter({ max: 10, windowMs: 60_000 }));
  a.use((_req, res) => {
    if (!lim.enforce("tok-row-1", res)) return;
    res.type("text/plain").send("served");
  });
  const ok = await request(a).get(GIT_REFS).expect(200);
  assert.match(String(ok.headers["ratelimit-policy"]), /"git_ip"; q=10; w=60;[^,]*, "git_token"; q=1; w=900/);
  assert.match(String(ok.headers["ratelimit"]), /"git_token"; r=0; t=\d+/);
  const blocked = await request(a).get(GIT_REFS).expect(429);
  assert.equal(blocked.text.startsWith("rate limit exceeded"), true);
  assert.ok(Number(blocked.headers["retry-after"]) >= 1);
});
