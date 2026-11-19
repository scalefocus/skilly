// Emits the Content-Security-Policy per request (SKILLY_SPEC.md §22). CSP is set HERE, not in
// next.config, because a per-request nonce can't be expressed as a static header. The other
// security headers (X-Frame-Options, nosniff, Referrer-Policy, HSTS, /api no-store) stay in
// next.config.mjs, which no longer sets CSP — so exactly one CSP header is emitted per response.
//
// Production (CSP_MODE=enforce|report-only): a fresh nonce authorizes the inline theme-bootstrap
// script AND — via the request-side CSP header Next parses — its own framework/hydration inline
// scripts; 'strict-dynamic' covers the chunks they load. Development and CSP_MODE=off keep the
// legacy 'unsafe-inline' policy (dev also needs 'unsafe-eval' for `next dev`'s eval-wrapped chunks).
// All decision logic lives in ./lib/csp (pure + unit-tested); this file is the Next adapter.
import { NextResponse, type NextRequest } from "next/server";
import { planCsp, getCspMode } from "./lib/csp";

// Node.js runtime (not Edge): skilly is self-hosted standalone Node (§2, never Vercel/edge), and
// the Node runtime reads `process.env.CSP_MODE` at request time — so the operator's deploy-time
// setting is honored, never build-inlined. Web Crypto (`crypto`) is a global in Node ≥20.
export const runtime = "nodejs";

/** 128-bit base64 nonce. */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function middleware(request: NextRequest): NextResponse {
  const plan = planCsp({
    mode: getCspMode(),
    isDev: process.env.NODE_ENV !== "production",
    isApi: request.nextUrl.pathname.startsWith("/api"),
    nonce: generateNonce(),
  });

  let response: NextResponse;
  if (plan.nonce) {
    // Forward the nonce on the request: the root layout reads `x-nonce`, and Next reads the
    // request-side CSP header to nonce its own inline scripts.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", plan.nonce);
    requestHeaders.set("content-security-policy", plan.value);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    response = NextResponse.next();
  }

  response.headers.set(plan.headerName, plan.value);
  if (plan.reportingEndpoints) response.headers.set("Reporting-Endpoints", plan.reportingEndpoints);
  return response;
}

export const config = {
  // Run on everything except Next internals and static asset files. API routes ARE matched (they
  // get the locked-down API CSP); documents get the nonce policy. Assets never need a CSP/nonce.
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|map)$).*)"],
};
