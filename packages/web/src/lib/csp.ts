// Content-Security-Policy construction + mode selection (SKILLY_SPEC.md §22).
//
// The policy is emitted per-request by `src/middleware.ts`, which mints the nonce; this module is
// the pure, testable core — it selects the mode from `CSP_MODE` and plans the header(s) to set.
// It imports nothing from `next/*`, so it runs unchanged inside the middleware AND under
// `node --test`.

export type CspMode = "enforce" | "report-only" | "off";

/** Where browsers POST CSP violation reports (see `app/api/csp-report`). */
export const CSP_REPORT_PATH = "/api/csp-report";
/** `report-to` group name; paired with a `Reporting-Endpoints` response header in middleware. */
export const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * Resolve the CSP posture from the environment. Defaults to the hardened `enforce`; an
 * unrecognized value ALSO falls back to `enforce` — fail-safe to the secure posture, never
 * silently unprotect on a typo (§22).
 */
export function getCspMode(env: Record<string, string | undefined> = process.env): CspMode {
  switch ((env.CSP_MODE ?? "").trim().toLowerCase()) {
    case "report-only":
      return "report-only";
    case "off":
      return "off";
    default:
      return "enforce"; // includes "" (unset) and any typo
  }
}

interface DocCspOpts {
  nonce?: string; // present ⇒ nonce-based script-src (production enforce/report-only)
  dev?: boolean; // `next dev`: eval-wrapped chunks need 'unsafe-eval', no nonce
  reporting?: boolean; // append report-uri/report-to directives
}

/**
 * Build the document (HTML) CSP. Script policy:
 *   - nonce set → `'nonce-…' 'strict-dynamic' 'self'` ('self' is the CSP2 fallback; 'strict-dynamic'
 *                 wins on CSP3 and covers the chunks the nonced bootstrap loads)
 *   - dev       → `'self' 'unsafe-inline' 'unsafe-eval'` (hydration needs eval under `next dev`)
 *   - otherwise → `'self' 'unsafe-inline'` (the legacy CSP_MODE=off fallback)
 * Every other directive is fixed and matches the audited policy (§22): style/img/connect/font
 * stay as-is because the app relies on inline styles (recharts/React), data-URI avatars, and
 * self-hosted fonts (verified — no external resources).
 */
export function buildDocumentCsp(opts: DocCspOpts = {}): string {
  const { nonce, dev, reporting } = opts;
  const scriptSrc = nonce
    ? `script-src 'nonce-${nonce}' 'strict-dynamic' 'self'`
    : dev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
  ];
  if (reporting) {
    directives.push(`report-uri ${CSP_REPORT_PATH}`, `report-to ${CSP_REPORT_GROUP}`);
  }
  return directives.join("; ");
}

/** API/route-handler CSP: these responses execute nothing, so lock everything down. */
export function buildApiCsp(): string {
  return "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
}

export type CspHeaderName = "Content-Security-Policy" | "Content-Security-Policy-Report-Only";

export interface CspPlan {
  /** Response header to set the policy under. */
  headerName: CspHeaderName;
  /** The policy string. */
  value: string;
  /** When set: inject as `x-nonce` (for the layout) + a request-side CSP header (so Next nonces its own scripts). */
  nonce?: string;
  /** When set: the `Reporting-Endpoints` response-header value. */
  reportingEndpoints?: string;
}

/**
 * Decide the exact header(s) to emit for one request — the whole policy decision, kept pure so it
 * can be unit-tested without a Next runtime. `nonce` is the candidate value the caller minted; it
 * is only adopted (returned in `plan.nonce`) when the hardened nonce policy applies.
 */
export function planCsp(input: { mode: CspMode; isDev: boolean; isApi: boolean; nonce: string }): CspPlan {
  const { mode, isDev, isApi, nonce: candidate } = input;

  // API responses run no scripts — a resource-free CSP in every mode; no nonce, no reporting.
  if (isApi) return { headerName: "Content-Security-Policy", value: buildApiCsp() };

  const useNonce = !isDev && mode !== "off";
  const reporting = useNonce; // report only when the hardened policy is active
  const nonce = useNonce ? candidate : undefined;
  const value = buildDocumentCsp({ nonce, dev: isDev, reporting });
  // Report-Only is a production posture; dev always emits an enforced (lenient) policy.
  const headerName: CspHeaderName =
    !isDev && mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

  return {
    headerName,
    value,
    nonce,
    reportingEndpoints: reporting ? `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"` : undefined,
  };
}
