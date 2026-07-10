// Tests for the CSP violation sink (SKILLY_SPEC.md §22). Uses Web Request/Response — no Next
// runtime needed. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route";
import { metrics } from "../../../lib/metrics";

const URL_ = "http://localhost/api/csp-report";

/** Read the current value of the counter from the Prometheus text exposition. */
function counter(): number {
  const line = metrics
    .render()
    .split("\n")
    .find((l) => l.startsWith("skilly_csp_reports_total ") && !l.startsWith("#"));
  return line ? Number(line.split(" ")[1]) : 0;
}

function post(body: string, headers: Record<string, string> = {}, ip = "10.0.0.1"): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": ip, ...headers },
    body,
  });
}

test("csp-report: accepts a legacy report and counts it", async () => {
  const before = counter();
  const res = await POST(
    post(JSON.stringify({ "csp-report": { "document-uri": "https://x/y", "violated-directive": "script-src" } }), {}, "10.0.0.10"),
  );
  assert.equal(res.status, 204);
  assert.equal(counter(), before + 1);
});

test("csp-report: accepts the Reporting-API array format", async () => {
  const body = JSON.stringify([{ type: "csp-violation", body: { documentURL: "https://x/y", effectiveDirective: "img-src" } }]);
  const res = await POST(post(body, { "content-type": "application/reports+json" }, "10.0.0.11"));
  assert.equal(res.status, 204);
});

test("csp-report: rejects malformed JSON with 400", async () => {
  const res = await POST(post("{not json", {}, "10.0.0.12"));
  assert.equal(res.status, 400);
});

test("csp-report: rejects an oversized body with 413", async () => {
  const huge = JSON.stringify({ "csp-report": { "document-uri": "x".repeat(20 * 1024) } });
  const res = await POST(post(huge, {}, "10.0.0.13"));
  assert.equal(res.status, 413);
});

test("csp-report: strips query strings from logged URIs (invariant #6)", async () => {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (m?: unknown) => { lines.push(String(m)); };
  try {
    const res = await POST(
      post(JSON.stringify({ "csp-report": { "document-uri": "https://host/p?token=SECRET#frag", "blocked-uri": "https://evil/x?a=b" } }), {}, "10.0.0.14"),
    );
    assert.equal(res.status, 204);
  } finally {
    console.warn = original;
  }
  const logged = lines.find((l) => l.includes("csp-violation"));
  assert.ok(logged, "expected a csp-violation log line");
  const rec = JSON.parse(logged!) as { documentUri?: string; blockedUri?: string };
  assert.equal(rec.documentUri, "https://host/p");
  assert.equal(rec.blockedUri, "https://evil/x");
  assert.ok(!JSON.stringify(rec).includes("SECRET"));
});

test("csp-report: rate limits a noisy client (429 after the window fills)", async () => {
  const ip = "10.9.9.9";
  let last = 204;
  for (let i = 0; i < 65; i++) {
    const res = await POST(post(JSON.stringify({ "csp-report": {} }), {}, ip));
    last = res.status;
  }
  assert.equal(last, 429);
});
