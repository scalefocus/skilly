// Adapter test for the CSP middleware (SKILLY_SPEC.md §22): asserts the right header(s) reach the
// response per CSP_MODE. The policy logic itself is covered exhaustively in lib/csp.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

function run(path: string, env: { NODE_ENV?: string; CSP_MODE?: string }) {
  const savedNode = process.env.NODE_ENV;
  const savedMode = process.env.CSP_MODE;
  // NODE_ENV is read-only in some typings; assign through a loose cast.
  (process.env as Record<string, string | undefined>).NODE_ENV = env.NODE_ENV;
  (process.env as Record<string, string | undefined>).CSP_MODE = env.CSP_MODE;
  try {
    return middleware(new NextRequest(`http://localhost${path}`));
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNode;
    (process.env as Record<string, string | undefined>).CSP_MODE = savedMode;
  }
}

test("middleware: prod enforce emits a nonce CSP + Reporting-Endpoints", () => {
  const res = run("/skills", { NODE_ENV: "production", CSP_MODE: "enforce" });
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "expected an enforcing CSP header");
  assert.match(csp!, /script-src 'nonce-[^']+' 'strict-dynamic' 'self'/);
  assert.match(csp!, /report-uri \/api\/csp-report/);
  assert.equal(res.headers.get("reporting-endpoints"), 'csp-endpoint="/api/csp-report"');
  assert.equal(res.headers.get("content-security-policy-report-only"), null);
});

test("middleware: prod report-only uses the Report-Only header only", () => {
  const res = run("/skills", { NODE_ENV: "production", CSP_MODE: "report-only" });
  assert.equal(res.headers.get("content-security-policy"), null);
  const ro = res.headers.get("content-security-policy-report-only");
  assert.ok(ro && ro.includes("'nonce-"), "expected a nonce policy on the Report-Only header");
});

test("middleware: prod off falls back to the legacy enforced policy (no nonce)", () => {
  const res = run("/skills", { NODE_ENV: "production", CSP_MODE: "off" });
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp!.includes("script-src 'self' 'unsafe-inline'"));
  assert.ok(!csp!.includes("'nonce-"));
  assert.equal(res.headers.get("reporting-endpoints"), null);
});

test("middleware: API paths get the resource-free CSP", () => {
  const res = run("/api/skills", { NODE_ENV: "production", CSP_MODE: "enforce" });
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
});

test("middleware: each request gets a fresh nonce", () => {
  const nonceOf = (path: string) =>
    /'nonce-([^']+)'/.exec(run(path, { NODE_ENV: "production", CSP_MODE: "enforce" }).headers.get("content-security-policy") ?? "")?.[1];
  const a = nonceOf("/skills");
  const b = nonceOf("/skills");
  assert.ok(a && b && a !== b, "nonces must differ per request");
});
