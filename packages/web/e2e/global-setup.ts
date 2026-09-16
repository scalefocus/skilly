// Playwright globalSetup: warm every route the suite touches BEFORE the first spec runs.
//
// `next dev` (webpack) compiles a route on its first request, and on a loaded CI agent that
// compile is where most of the suite's wall-clock — and most of its flakes — used to go. Measured
// on the CI-mirror stack: `/api/users/suggest` 24.7s and `/api/users/[id]/card` 12.6s on first
// hit, ~200ms after. A spec paying that inside its own budget fails; the next spec to touch the
// same route passes with identical code — the signature of the "first test in the file fails,
// second passes" pattern the CI runs showed. Paying every compile up front, once, means each
// spec meets an already-built route and only the app's real work is on its clock.
//
// Two layers, both plain HTTP against the running server:
//   1. PAGE routes — the server component + its route module.
//   2. API routes — every `src/app/api/**/route.ts`, discovered from the tree so a new endpoint
//      is warmed without anyone remembering to list it. Dynamic segments get plausible values; a
//      404/405 still compiles the module, which is all we need. Routes whose GET has a side
//      effect (auth, the email OAuth hop, exports, erase) are skipped.
// Client bundles are NOT pre-hydrated here — see the note at the end for why that was removed.
//
// This only holds if the dev server KEEPS what it compiled: by default `next dev` retains 5
// on-demand entries and disposes the rest after 60s idle, which undid this warm-up within a
// minute (routes were observed re-compiling mid-run). The server must run with
// SKILLY_DEV_KEEP_ROUTES=1 (next.config.mjs → onDemandEntries); the Playwright webServer and both
// CI e2e stages set it.
//
// Best-effort by design: a route that fails here is logged, not fatal — the spec that owns it
// reports the failure with a real assertion and a real error context. Playwright starts the
// `webServer` before running this, so the server is up (CI) or already running (local reuse).
import { request, type FullConfig } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Every page route a spec navigates to. Keep in sync when a spec starts visiting a new route.
const PAGES = [
  "/",
  "/profile",
  "/admin",
  "/admin/rum",
  "/namespaces",
  "/installed",
  "/catalog",
  "/catalog?ns=team-a&nsName=Team%20A",
  "/catalog/marketplaces",
  "/requests",
  "/leaderboard",
  "/notifications",
  "/usage",
  "/whats-new",
  "/quick-start",
  "/skills/global/pdf-tools",
  "/skills/global/web-scraper",
  "/skills/global/lint-fixer",
  "/skills/global/secret-helper",
  "/proposals",
  "/proposals/00000000-0000-0000-0000-000000000000",
  "/propose",
  "/marketplaces",
  "/mcp",
  "/audit",
  "/system-log",
  "/tokens",
  "/achievements/00000000-0000-0000-0000-000000000000",
  // The OAuth routes are POST-only route handlers: a GET answers 405 but compiles them all the same.
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/consent",
];

// API subtrees a GET must never touch: sign-in/out and cookie clearing, the email OAuth hop,
// heavy exports, and anything that erases or trims. Everything else is read-only on GET or 405.
const SKIP_API = [/^\/api\/auth\b/, /\/admin\/email\/(connect|callback)$/, /\/export$/, /\/erase$/, /\/trim$/, /\/admin\/jobs\//];

// Plausible values for dynamic segments — real seed rows where a real one is cheap to know,
// a nil UUID otherwise (404s compile just as well as 200s).
const SEGMENT: Record<string, string> = {
  "[ns]": "global",
  "[slug]": "pdf-tools",
  "[semver]": "1.1.0",
  "[index]": "0",
};
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** All API route paths under `src/app/api`, as request paths with dynamic segments filled in. */
function apiRoutes(apiDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const rel = relative(apiDir, dir).split(sep).filter(Boolean);
        const fill = (seg: string) => (seg.startsWith("[") ? SEGMENT[seg] ?? (seg.startsWith("[...") ? "x" : NIL_UUID) : seg);
        const path = "/api/" + rel.map(fill).join("/");
        if (!SKIP_API.some((rx) => rx.test(path))) out.push(path);
      }
    }
  };
  walk(apiDir);
  return out.sort();
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = (config.projects[0]?.use.baseURL as string | undefined) ?? "http://localhost:3000";
  const started = Date.now();
  const log = (msg: string) => console.log(`[e2e warm-up] ${msg}`);
  const ctx = await request.newContext({ baseURL });
  try {
    // Sign in as the dev admin (the same handshake fixtures.ts uses) so signed-in-only pages
    // compile their real content, not the signed-out shell. Best-effort like everything here: a
    // server that answers HTML instead of JSON (still booting, or broken) must not abort the run —
    // the specs will report that with a real assertion.
    try {
      const csrf = (await (await ctx.get("/api/auth/csrf")).json()) as { csrfToken: string };
      const signIn = await ctx.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
      if (!signIn.ok()) console.warn(`[e2e warm-up] dev sign-in answered ${signIn.status()} — warming the signed-out shell only`);
    } catch (err) {
      console.warn(`[e2e warm-up] dev sign-in failed (${err instanceof Error ? err.message : String(err)}) — warming the signed-out shell only`);
    }

    const hit = async (path: string) => {
      const t = Date.now();
      try {
        const res = await ctx.get(path, { timeout: 120_000, maxRedirects: 0 });
        log(`${res.status()} ${path} (${Date.now() - t}ms)`);
      } catch (err) {
        console.warn(`[e2e warm-up] ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // 1. Pages over HTTP.
    for (const route of PAGES) await hit(route);

    // 2. Every API route, discovered from the source tree (config lives in e2e/, next to src/).
    const api = apiRoutes(join(config.rootDir, "..", "src", "app", "api"));
    log(`${api.length} API routes discovered`);
    for (const route of api) await hit(route);

    // Deliberately NO browser pass. Hydrating every page in a real browser here was measured at
    // ~10 minutes on the mirror stack and saturated the dev server (`/api/auth/session` at 22s)
    // for the specs that followed — all to pre-pay a client-chunk compile the first spec pays
    // once, at ~40s. HTTP compiles the server side of every route; that is the part worth buying.

    log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await ctx.dispose();
  }
}
