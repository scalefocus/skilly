// Unit tests for the CSP policy core (SKILLY_SPEC.md §22). Pure — no Next runtime, no DB.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApiCsp, buildDocumentCsp, getCspMode, planCsp } from "./csp";

/** Pull one directive (e.g. "script-src") out of a policy string. */
function directive(policy: string, name: string): string | undefined {
  return policy.split("; ").find((d) => d === name || d.startsWith(`${name} `));
}

test("getCspMode: defaults to enforce, and fails safe on unknown/empty", () => {
  assert.equal(getCspMode({}), "enforce");
  assert.equal(getCspMode({ CSP_MODE: "" }), "enforce");
  assert.equal(getCspMode({ CSP_MODE: "enforce" }), "enforce");
  assert.equal(getCspMode({ CSP_MODE: "report-only" }), "report-only");
  assert.equal(getCspMode({ CSP_MODE: "off" }), "off");
  // case + whitespace tolerant
  assert.equal(getCspMode({ CSP_MODE: "  REPORT-ONLY " }), "report-only");
  assert.equal(getCspMode({ CSP_MODE: "Off" }), "off");
  // typo never silently unprotects
  assert.equal(getCspMode({ CSP_MODE: "reportonly" }), "enforce");
  assert.equal(getCspMode({ CSP_MODE: "disable" }), "enforce");
});

test("buildApiCsp: resource-free lockdown", () => {
  assert.equal(buildApiCsp(), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
});

test("buildDocumentCsp: nonce policy drops unsafe-inline for scripts, keeps the audited rest", () => {
  const p = buildDocumentCsp({ nonce: "ABC123", reporting: true });
  assert.equal(directive(p, "script-src"), "script-src 'nonce-ABC123' 'strict-dynamic' 'self'");
  // scripts must NOT allow unsafe-inline/eval under the nonce policy
  assert.ok(!directive(p, "script-src")!.includes("'unsafe-inline'"));
  assert.ok(!directive(p, "script-src")!.includes("'unsafe-eval'"));
  // unchanged directives verified in the analysis
  assert.equal(directive(p, "default-src"), "default-src 'self'");
  assert.equal(directive(p, "frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive(p, "object-src"), "object-src 'none'");
  assert.equal(directive(p, "base-uri"), "base-uri 'self'");
  assert.equal(directive(p, "img-src"), "img-src 'self' data:"); // data-URI avatars
  assert.equal(directive(p, "style-src"), "style-src 'self' 'unsafe-inline'"); // recharts/React inline styles
  assert.equal(directive(p, "connect-src"), "connect-src 'self'");
  assert.equal(directive(p, "font-src"), "font-src 'self'");
  assert.equal(directive(p, "form-action"), "form-action 'self'");
  // reporting directives present when requested
  assert.equal(directive(p, "report-uri"), "report-uri /api/csp-report");
  assert.equal(directive(p, "report-to"), "report-to csp-endpoint");
});

// ── form-action: the §29 consent-screen carve-out ──────────────────────────────────────────────
// The consent POST is answered with a 303 to the client's registered redirect_uri — a different
// origin — and browsers enforce form-action ACROSS REDIRECTS. Under 'self' that navigation is
// aborted and the authorization code never reaches the client, silently.

test("buildDocumentCsp: form-action widens ONLY for the consent screen", () => {
  const normal = buildDocumentCsp({ nonce: "N" });
  assert.equal(directive(normal, "form-action"), "form-action 'self'");

  const consent = buildDocumentCsp({ nonce: "N", crossOriginForm: true });
  assert.equal(
    directive(consent, "form-action"),
    "form-action 'self' http://127.0.0.1:* http://localhost:* https:",
  );
});

test("buildDocumentCsp: the consent carve-out touches form-action and nothing else", () => {
  const normal = buildDocumentCsp({ nonce: "N", reporting: true });
  const consent = buildDocumentCsp({ nonce: "N", reporting: true, crossOriginForm: true });
  const only = (p: string) => p.split("; ").filter((d) => !d.startsWith("form-action"));
  assert.deepEqual(only(consent), only(normal), "no directive but form-action may differ");
});

test("planCsp: the widened form-action is keyed on the authorize path alone", () => {
  const base = { mode: "enforce" as const, isDev: false, isApi: false, nonce: "N" };
  const formAction = (pathname?: string) => directive(planCsp({ ...base, pathname }).value, "form-action");

  assert.equal(formAction("/oauth/authorize"), "form-action 'self' http://127.0.0.1:* http://localhost:* https:");
  // Everything else keeps the default — including neighbours and near-misses, so the carve-out
  // can't be widened by a prefix match or an unrelated OAuth route.
  for (const p of ["/oauth/consent", "/oauth/register", "/oauth/authorize/extra", "/catalog", "/", undefined]) {
    assert.equal(formAction(p), "form-action 'self'", `${p ?? "(no path)"} must not be widened`);
  }
});

test("planCsp: the consent carve-out applies in dev and every CSP mode, but never to /api", () => {
  // The blocked redirect is a browser behavior, not a posture — a dev or CSP_MODE=off stack that
  // still emits an enforced (lenient) policy must carry the carve-out too, or consent breaks there.
  for (const mode of ["enforce", "report-only", "off"] as const) {
    for (const isDev of [true, false]) {
      const plan = planCsp({ mode, isDev, isApi: false, nonce: "N", pathname: "/oauth/authorize" });
      assert.equal(
        directive(plan.value, "form-action"),
        "form-action 'self' http://127.0.0.1:* http://localhost:* https:",
        `mode=${mode} isDev=${isDev}`,
      );
    }
  }
  // API responses stay on the resource-free lockdown, which has no form-action at all.
  const api = planCsp({ mode: "enforce", isDev: false, isApi: true, nonce: "N", pathname: "/oauth/authorize" });
  assert.equal(api.value, buildApiCsp());
  assert.equal(directive(api.value, "form-action"), undefined);
});

test("buildDocumentCsp: no report directives unless reporting", () => {
  const p = buildDocumentCsp({ nonce: "N" });
  assert.equal(directive(p, "report-uri"), undefined);
  assert.equal(directive(p, "report-to"), undefined);
});

test("buildDocumentCsp: dev policy needs unsafe-eval + unsafe-inline, no nonce", () => {
  const p = buildDocumentCsp({ dev: true });
  assert.equal(directive(p, "script-src"), "script-src 'self' 'unsafe-inline' 'unsafe-eval'");
});

test("buildDocumentCsp: legacy (off) policy is unsafe-inline without eval or nonce", () => {
  const p = buildDocumentCsp({});
  assert.equal(directive(p, "script-src"), "script-src 'self' 'unsafe-inline'");
});

test("planCsp: production enforce → nonce policy on the enforcing header, with reporting", () => {
  const plan = planCsp({ mode: "enforce", isDev: false, isApi: false, nonce: "N0" });
  assert.equal(plan.headerName, "Content-Security-Policy");
  assert.equal(plan.nonce, "N0");
  assert.ok(plan.value.includes("'nonce-N0' 'strict-dynamic' 'self'"));
  assert.equal(plan.reportingEndpoints, 'csp-endpoint="/api/csp-report"');
});

test("planCsp: production report-only → same nonce policy on the Report-Only header", () => {
  const plan = planCsp({ mode: "report-only", isDev: false, isApi: false, nonce: "N1" });
  assert.equal(plan.headerName, "Content-Security-Policy-Report-Only");
  assert.equal(plan.nonce, "N1");
  assert.ok(plan.value.includes("'nonce-N1'"));
  assert.equal(plan.reportingEndpoints, 'csp-endpoint="/api/csp-report"');
});

test("planCsp: off → legacy enforced policy, no nonce, no reporting", () => {
  const plan = planCsp({ mode: "off", isDev: false, isApi: false, nonce: "N2" });
  assert.equal(plan.headerName, "Content-Security-Policy");
  assert.equal(plan.nonce, undefined);
  assert.equal(plan.reportingEndpoints, undefined);
  assert.ok(plan.value.includes("script-src 'self' 'unsafe-inline'"));
  assert.ok(!plan.value.includes("'strict-dynamic'"));
});

test("planCsp: development is always the lenient enforced policy regardless of mode", () => {
  for (const mode of ["enforce", "report-only", "off"] as const) {
    const plan = planCsp({ mode, isDev: true, isApi: false, nonce: "N3" });
    assert.equal(plan.headerName, "Content-Security-Policy", `mode=${mode}`);
    assert.equal(plan.nonce, undefined, `mode=${mode}`);
    assert.equal(plan.reportingEndpoints, undefined, `mode=${mode}`);
    assert.ok(plan.value.includes("'unsafe-eval'"), `mode=${mode}`);
  }
});

test("planCsp: API responses get the resource-free CSP in every mode, never a nonce", () => {
  for (const mode of ["enforce", "report-only", "off"] as const) {
    const plan = planCsp({ mode, isDev: false, isApi: true, nonce: "N4" });
    assert.equal(plan.headerName, "Content-Security-Policy", `mode=${mode}`);
    assert.equal(plan.value, buildApiCsp(), `mode=${mode}`);
    assert.equal(plan.nonce, undefined, `mode=${mode}`);
  }
});
