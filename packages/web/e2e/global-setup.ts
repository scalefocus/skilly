// Playwright globalSetup: warm every route the suite touches BEFORE the first spec runs.
//
// `next dev` compiles a route on its first request, and on a loaded CI agent that compile is where
// most of the suite's wall-clock — and most of its flakes — used to go. Measured on the CI-mirror
// stack under webpack: `/api/users/suggest` 24.7s and `/api/users/[id]/card` 12.6s on first hit,
// ~200ms after. A spec paying that inside its own budget fails; the next spec to touch the
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
// E2E_WARM=pages stops after layer 1. Under webpack every warmed route stayed pinned in the one
// compiler, and each new compile re-sealed the whole pinned graph, so the full warm-up was slow AND
// heavy: measured locally, ~31 min and ~9.7 GB private memory with an 8 GB heap ceiling (the heap
// cap did not bound it), against ~3 min and ~4.3 GB after the pages alone. Turbopack compiles each
// route on its own and keeps the output in its disk cache, so the full sweep is now far cheaper.
// E2E_WARM=core is pages plus CORE_API (below), the routes almost every spec meets: on the CI agent
// a cold compile took 10–37 s and held up every request behind it, which pages-only could not
// absorb. ci/e2e-run.sh sets core for every Jenkins run, during which a fully warmed webpack server
// got OOM-killed.
//
// Worker users (SKILLY_SPEC.md §16 item 18): under E2E_WORKER_USERS=1 each Playwright worker signs
// in as its own seeded user (fixtures.ts), so every one of them (1..E2E_WORKERS) gets the same
// onboarded stamp, and its What's new marker pre-stamped at the running version, before any spec.
//
// Every scope also stamps the dev user onboarded. A fresh stack's dev user has never seen Quick
// start, so the first-login gate (AppShell, §8) sends the first page that learns this to
// /quick-start, mid-spec. A full run used to clear it by luck of order (achievements.spec runs
// second); a sampled run carried it into whatever spec came first.
//
// This only holds if the dev server KEEPS what it compiled. Webpack's `next dev` disposed idle
// entries after 60s, which undid this warm-up within a minute. Turbopack writes every compiled route
// to the build folder's disk cache; with SKILLY_E2E_DEV_SERVER=1 (next.config.mjs → "full" memory
// eviction) it then drops that output from memory, and a spec's first request restores it from disk
// instead of compiling it. The Playwright webServer and both CI e2e stages set it.
//
// Best-effort by design: a route that fails here is logged, not fatal — the spec that owns it
// reports the failure with a real assertion and a real error context. Playwright starts the
// `webServer` before running this, so the server is up (CI) or already running (local reuse).
// The one fatal case is the server itself going away: a refused connection means nothing listens on
// the port any more (on a shared CI agent, almost always the kernel's OOM killer), and Playwright
// does not restart it — so stop here with that cause rather than run every spec into ECONNREFUSED.
import { request, type APIRequestContext, type FullConfig } from "@playwright/test";
import { APP_VERSION } from "@skilly/shared/version";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { e2eWorkerOid } from "../src/lib/devAuth";

// Every page route a spec navigates to. Keep in sync when a spec starts visiting a new route.
const PAGES = [
  "/",
  "/profile",
  "/admin",
  "/admin/rum",
  "/admin/ideas",
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
// cards were still loading two minutes in and the specs' 45 s response waits ran out. Warming ~85
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
  // ...and its comments feed (the admin test waits 15 s for a seeded comment) and the per-response
  // delete. Cold, comments compiled for >16 s on the CI agent and the serial file went down again.
  "/api/admin/survey/comments",
  "/api/admin/survey/responses/00000000-0000-0000-0000-000000000000",
  // The survey card itself (survey.spec, every signed-in page): start/close/responses/bug. Cold,
  // close and responses compiled 15-17 s each mid-test.
  "/api/me/survey/start",
  "/api/me/survey/close",
  "/api/me/survey/responses",
  "/api/me/survey/bug",
  "/api/admin/rum/routes/%2Fcatalog/users",
  "/api/admin/users/online",
  "/api/admin/users/active-series",
  // /leaderboard, /usage and the home page: each gates its content (and, on /leaderboard, the
  // feature-use report the survey spec waits on) on one data call. Cold, leaderboard held every
  // request behind it for ~20 s, usage compiled 20 s and stats 18 s on the CI agent.
  "/api/leaderboard",
  "/api/usage",
  "/api/stats",
  // /catalog + the header search
  "/api/skills",
  "/api/skills/facets",
  "/api/skills/suggest",
  "/api/skills/featured",
  // §50.6 the home page's Hyped section loads on every visit, like Featured.
  "/api/skills/hyped",
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
  // The skill page's Install panel and its Shared with card (§23, §42). Cold on the CI agent, the
  // mint compiled 26 s while already-installed.spec waited 15 s for the command, and the revoke
  // compiled 20 s while namespace-sharing.spec waited 15 s for the chip to go. The mint is
  // POST-only and the per-namespace grant PUT/DELETE-only: a GET 405s and compiles all the same.
  "/api/skills/global/pdf-tools/install",
  "/api/skills/global/pdf-tools/grants",
  "/api/skills/global/pdf-tools/grants/00000000-0000-0000-0000-000000000000",
  // Every spec with a skill fixture tears it down through these two (helpers/skills.ts
  // deleteSkillFully). POST-only; cold they compiled 27–30 s and 16–19 s once per pass, holding
  // every other request behind them for that long.
  "/api/skills/global/pdf-tools/archive",
  "/api/skills/global/pdf-tools/delete",
  // /installed: the list, and the Show install URL reveal. Cold, the list compiled 16 s under
  // already-installed.spec's 20 s wait for the highlighted row and the reveal 14 s under its 15 s
  // wait for the command.
  "/api/installs",
  "/api/installs/00000000-0000-0000-0000-000000000000/command",
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

  /** The dev credentials handshake fixtures.ts uses; `oid` omitted = the dev admin. */
  const signIn = async (on: APIRequestContext, oid?: string) => {
    const csrf = (await (await on.get("/api/auth/csrf")).json()) as { csrfToken: string };
    return on.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true", ...(oid ? { oid } : {}) } });
  };

  // Stamp onboarded (idempotent — never moves the date), then mark the "Read the Manual" badge it
  // awards read, so it does not toast over the first page of every spec. Best-effort: a spec that
  // depends on it fails with a real assertion if it did not take.
  const markOnboarded = async (on: APIRequestContext, who: string) => {
    try {
      const res = await on.post("/api/me/onboarded", { timeout: 120_000 });
      if (!res.ok()) return console.warn(`[e2e warm-up] marking ${who} onboarded answered ${res.status()}`);
      const list = (await (await on.get("/api/notifications", { timeout: 120_000 })).json()) as {
        items?: { id: string; type: string; readAt: string | null; payload?: { key?: string } }[];
      };
      const ids = (list.items ?? [])
        .filter((n) => n.type === "achievement.earned" && n.payload?.key === "onboarded" && !n.readAt)
        .map((n) => n.id);
      if (ids.length) await on.post("/api/notifications/read", { data: { ids }, timeout: 120_000 });
      log(`${who} onboarded${ids.length ? " (badge notification marked read)" : ""}`);
    } catch (err) {
      console.warn(`[e2e warm-up] marking ${who} onboarded failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Each worker user, in its own cookie jar: sign in, stamp onboarded, pre-stamp What's new.
  const prepareWorkerUsers = async () => {
    if (process.env.E2E_WORKER_USERS !== "1") return;
    const workers = Number(process.env.E2E_WORKERS ?? 1);
    for (let n = 1; n <= workers; n++) {
      const oid = e2eWorkerOid(n);
      const on = await request.newContext({ baseURL });
      try {
        const res = await signIn(on, oid);
        if (!res.ok()) {
          console.warn(`[e2e warm-up] dev sign-in as ${oid} answered ${res.status()} — is db/seed.e2e.sql applied?`);
          continue;
        }
        await markOnboarded(on, oid);
        await on.post("/api/me/whats-new-seen", { data: { version: APP_VERSION }, timeout: 120_000 });
      } catch (err) {
        console.warn(`[e2e warm-up] preparing ${oid} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await on.dispose();
      }
    }
  };

  try {
    // Sign in as the dev admin (the same handshake fixtures.ts uses) so signed-in-only pages
    // compile their real content, not the signed-out shell. Best-effort like everything here: a
    // server that answers HTML instead of JSON (still booting, or broken) must not abort the run —
    // the specs will report that with a real assertion.
    try {
      const res = await signIn(ctx);
      if (!res.ok()) console.warn(`[e2e warm-up] dev sign-in answered ${res.status()} — warming the signed-out shell only`);
      else await markOnboarded(ctx, "dev user");
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

    await prepareWorkerUsers();

    log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await ctx.dispose();
  }
}
