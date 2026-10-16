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
// E2E_WARM=pages stops after layer 1. Every warmed route stays pinned in the one webpack compiler,
// and each new compile re-seals the whole pinned graph, so the full warm-up is slow AND heavy:
// measured locally, ~31 min and ~9.7 GB private memory with an 8 GB heap ceiling (the heap cap
// does not bound it), against ~3 min and ~4.3 GB after the pages alone. A run that executes only a
// slice of the suite (a single spec) does not need every API route pinned; the routes its specs
// hit compile on first use against that much smaller graph. E2E_WARM=core is pages plus CORE_API
// (below), the routes almost every spec meets: on the CI agent a cold compile took 10–37 s and
// held up every request behind it, which pages-only could not absorb. ci/e2e-shard.sh sets core
// for the quick run, which a fully warmed server got OOM-killed during.
//
// Every scope also stamps the dev user onboarded. A fresh stack's dev user has never seen Quick
// start, so the first-login gate (AppShell, §8) sends the first page that learns this to
// /quick-start, mid-spec. A full run used to clear it by luck of order (achievements.spec runs
// second); a sampled run carried it into whatever spec came first.
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
// The one fatal case is the server itself going away: a refused connection means nothing listens on
// the port any more (on a shared CI agent, almost always the kernel's OOM killer), and Playwright
// does not restart it — so stop here with that cause rather than run every spec into ECONNREFUSED.
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
  // Content-addressed icon bytes (§33) — a non-hex name 404s without touching storage, but the
  // route still compiles; icon.spec otherwise paid ~18s for it mid-run.
  "/skill-icons/warm-up.png",
];

// E2E_WARM=core: the API routes nearly every spec meets — the app shell's on-load calls (every
// signed-in page) and what the most-visited pages (/admin, /catalog, a skill page, /propose,
// /proposals/[id], /profile) fetch as they load. Cold, these compiled one after another on the
// first spec to open such a page: on the CI agent 10–37 s each, and /admin alone fires ~15, so its
// cards were still loading two minutes in and the specs' 45 s response waits ran out. Warming ~70
// keeps the pinned graph far below the full sweep's (~159). Keep in sync when the shell or one of
// these pages starts loading a new endpoint. POST-only routes answer GET with 405 and compile all the same.
const CORE_API = [
  // App shell (AppShell.tsx) + the e2e sign-in (fixtures.ts devSignIn).
  "/api/me",
  "/api/me/whats-new-seen",
  "/api/me/survey/check",
  "/api/me/features/used",
  "/api/me/following",
  "/api/messages",
  "/api/notifications",
  "/api/notifications/read",
  "/api/nav-badges",
  "/api/system-banner",
  "/api/presence/page",
  "/api/levels",
  "/api/leaders",
  "/api/rum",
  "/api/collections/mine",
  // /admin
  "/api/admin/namespaces",
  "/api/admin/system-banner",
  "/api/admin/mcp",
  "/api/admin/search/languages",
  "/api/admin/search/synonyms",
  "/api/admin/settings",
  "/api/admin/ai",
  "/api/admin/ai/models",
  "/api/admin/ai/test",
  "/api/admin/ai/timeouts",
  "/api/admin/email",
  "/api/admin/policy",
  "/api/policy/rules",
  "/api/admin/jobs/search-index",
  "/api/admin/jobs/content-risk",
  "/api/admin/jobs/quality",
  "/api/admin/jobs/related-rebuild",
  // /admin/rum — its Currently online card, the routes table, the errors list, and the per-route
  // users expander. Cold, summary alone compiled for 15 s and the expander's route queued behind
  // the errors compile, so rum.spec's 10–15 s assertions ran out on both attempts.
  "/api/admin/rum/summary",
  "/api/admin/rum/errors",
  // The Survey results card on /admin/rum (§36). Cold, it compiled 20–50 s in three of five CI
  // passes; survey.spec's admin test waits 20 s for the funnel and, being serial, took the rest of
  // the file down with it.
  "/api/admin/survey/summary",
  "/api/admin/rum/routes/%2Fcatalog/users",
  "/api/admin/users/online",
  "/api/admin/users/active-series",
  // /catalog + the header search
  "/api/skills",
  "/api/skills/facets",
  "/api/skills/suggest",
  "/api/skills/featured",
  "/api/collections",
  "/api/collections/suggest",
  // /skills/[ns]/[slug]
  "/api/skills/global/pdf-tools",
  "/api/skills/global/pdf-tools/readme",
  "/api/skills/global/pdf-tools/maintainers",
  "/api/skills/global/pdf-tools/content-risk",
  "/api/skills/global/pdf-tools/ai-prereview",
  "/api/skills/global/pdf-tools/discussion",
  // The read mark fires on every load with the discussion expanded; the moderator delete is
  // DELETE-only (GET 405s and compiles). Cold, each took ~18 s mid-spec in skill-discussion.spec,
  // and the dev server answered the next spec's page load with a 500 while it rewrote manifests.
  "/api/skills/global/pdf-tools/discussion/read",
  "/api/skills/global/pdf-tools/discussion/00000000-0000-0000-0000-000000000000",
  "/api/skills/global/pdf-tools/related",
  "/api/skills/global/pdf-tools/usage-series",
  // /propose
  "/api/categories",
  "/api/namespaces",
  "/api/namespaces/share-targets",
  "/api/namespaces/administered",
  "/api/propose/ai-draft",
  "/api/skills/slug-matches",
  "/api/pointer/refs",
  // Submit + review: the upload and create a spec's proposal fixture POSTs, and what
  // /proposals/[id] loads and posts. Cold, the detail GET compiled for 66 s and the actions POST
  // queued behind the messages compile (43 s), so proposal-revise.spec timed out on both attempts.
  "/api/uploads",
  "/api/proposals",
  "/api/proposals/duplicate-check",
  "/api/proposals/00000000-0000-0000-0000-000000000000",
  "/api/proposals/00000000-0000-0000-0000-000000000000/actions",
  "/api/proposals/00000000-0000-0000-0000-000000000000/messages",
  "/api/proposals/00000000-0000-0000-0000-000000000000/changes",
  // /profile
  "/api/users/00000000-0000-0000-0000-000000000000/achievements",
];

// API subtrees a GET must never touch: sign-in/out and cookie clearing, the email OAuth hop,
// heavy exports, and anything that erases or trims. Everything else is read-only on GET or 405 —
// including /api/admin/jobs/*, whose GETs are the Maintenance card's status polls (triggers are
// POST-only). Leaving those cold made /admin compile them mid-spec and Fast-Refresh-reload the page.
const SKIP_API = [/^\/api\/auth\b/, /\/admin\/email\/(connect|callback)$/, /\/export$/, /\/erase$/, /\/trim$/];

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
  const scope = process.env.E2E_WARM || "all";
  if (scope !== "all" && scope !== "core" && scope !== "pages") {
    throw new Error(`[e2e warm-up] E2E_WARM must be "all", "core" or "pages" (got "${scope}")`);
  }
  const ctx = await request.newContext({ baseURL });

  // Stamp onboarded (idempotent — never moves the date), then mark the "Read the Manual" badge it
  // awards read, so it does not toast over the first page of every spec. Best-effort: a spec that
  // depends on it fails with a real assertion if it did not take.
  const markOnboarded = async () => {
    try {
      const res = await ctx.post("/api/me/onboarded", { timeout: 120_000 });
      if (!res.ok()) return console.warn(`[e2e warm-up] marking the dev user onboarded answered ${res.status()}`);
      const list = (await (await ctx.get("/api/notifications", { timeout: 120_000 })).json()) as {
        items?: { id: string; type: string; readAt: string | null; payload?: { key?: string } }[];
      };
      const ids = (list.items ?? [])
        .filter((n) => n.type === "achievement.earned" && n.payload?.key === "onboarded" && !n.readAt)
        .map((n) => n.id);
      if (ids.length) await ctx.post("/api/notifications/read", { data: { ids }, timeout: 120_000 });
      log(`dev user onboarded${ids.length ? " (badge notification marked read)" : ""}`);
    } catch (err) {
      console.warn(`[e2e warm-up] marking the dev user onboarded failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    // Sign in as the dev admin (the same handshake fixtures.ts uses) so signed-in-only pages
    // compile their real content, not the signed-out shell. Best-effort like everything here: a
    // server that answers HTML instead of JSON (still booting, or broken) must not abort the run —
    // the specs will report that with a real assertion.
    try {
      const csrf = (await (await ctx.get("/api/auth/csrf")).json()) as { csrfToken: string };
      const signIn = await ctx.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
      if (!signIn.ok()) console.warn(`[e2e warm-up] dev sign-in answered ${signIn.status()} — warming the signed-out shell only`);
      else await markOnboarded();
    } catch (err) {
      console.warn(`[e2e warm-up] dev sign-in failed (${err instanceof Error ? err.message : String(err)}) — warming the signed-out shell only`);
    }

    const hit = async (path: string) => {
      const t = Date.now();
      try {
        const res = await ctx.get(path, { timeout: 120_000, maxRedirects: 0 });
        log(`${res.status()} ${path} (${Date.now() - t}ms)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("ECONNREFUSED")) {
          throw new Error(
            `[e2e warm-up] the dev server at ${baseURL} refused the connection for ${path} — it has exited ` +
              `(see the [WebServer] output above; on a shared CI agent, check for an OOM kill). ` +
              `Not running the suite against a dead server.`,
          );
        }
        console.warn(`[e2e warm-up] ${path} failed: ${message}`);
      }
    };

    // 1. Pages over HTTP.
    for (const route of PAGES) await hit(route);

    // 2. Every API route, discovered from the source tree (config lives in e2e/, next to src/).
    if (scope === "pages") {
      log("E2E_WARM=pages — API routes compile on first use");
    } else if (scope === "core") {
      log(`E2E_WARM=core — ${CORE_API.length} core API routes; the rest compile on first use`);
      for (const route of CORE_API) await hit(route);
    } else {
      const api = apiRoutes(join(config.rootDir, "..", "src", "app", "api"));
      log(`${api.length} API routes discovered`);
      for (const route of api) await hit(route);
    }

    // Deliberately NO browser pass. Hydrating every page in a real browser here was measured at
    // ~10 minutes on the mirror stack and saturated the dev server (`/api/auth/session` at 22s)
    // for the specs that followed — all to pre-pay a client-chunk compile the first spec pays
    // once, at ~40s. HTTP compiles the server side of every route; that is the part worth buying.

    log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await ctx.dispose();
  }
}
