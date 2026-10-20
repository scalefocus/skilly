// Playwright config for the skilly e2e suite. Lives outside `src` so it is excluded from the
// Next.js typecheck/build. The suite runs against the DEV stack (SKILLY_DEV_AUTH=1) — a live web
// server + a migrated & seeded Postgres + MinIO. It is opt-in (browsers + a live stack required),
// so it is NOT part of the default `pnpm -r test`; CI runs it behind a gate (the Jenkins E2E_TESTS
// dropdown: FULL_E2E_TESTS, or QUICK_E2E_TESTS for a random 10% sample drawn by
// ci/e2e-quick-list.mjs; the GitHub Actions `e2e` job).
//
// Locally:
//   docker compose … up -d postgres minio migrate     # backends + migrations
//   psql … < db/seed.dev.sql                           # seed the dev catalog + dev-admin user
//   SKILLY_DEV_AUTH=1 SKILLY_DEV_OID=dev-admin-oid pnpm --filter @skilly/web dev   # (optional)
//   npx playwright install chromium                    # one-time: fetch the browser
//   pnpm --filter @skilly/web e2e
//
// The `webServer` below auto-starts `next dev` when nothing is already serving baseURL, inheriting
// the launching shell's env (so DATABASE_URL / S3_* / SKILLY_DEV_AUTH must be set there). Point at
// a different target with PLAYWRIGHT_BASE_URL.
import { defineConfig, devices } from "@playwright/test";
import { totalmem } from "node:os";

// Heap ceiling for the auto-started dev server. `next dev` defaults to half the machine's RAM and
// restarts itself at 80% of that, i.e. at 40% of RAM. Under webpack, with ~180 routes kept compiled,
// the dev compiler crossed that line twice per CI run and each restart discarded the warm-up.
// Turbopack keeps its compiled output outside the JS heap (and, for this server, on disk:
// next.config.mjs), so the heap now stays far below the line. If it ever grows again, do NOT answer
// that by raising the ceiling: V8 defers full collections while far below it, so a ceiling near RAM
// fills with garbage until the kernel OOM-kills the server (a 10.8 GB ceiling on a 16 GB CI agent
// did, mid-warm-up). Half of RAM, capped at 8 GB — the same cap ci/e2e-shard-plan.sh applies in
// Jenkins. Next honours an explicit --max-old-space-size and skips its own default; a caller's own wins.
const callerNodeOptions = process.env.NODE_OPTIONS ?? "";
const devServerHeapMb = Math.min(Math.floor((totalmem() / 1024 / 1024) * 0.5), 8192);
const devServerNodeOptions = /--max[-_]old[-_]space[-_]size/.test(callerNodeOptions)
  ? callerNodeOptions
  : `${callerNodeOptions} --max-old-space-size=${devServerHeapMb}`.trim();

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
// The auto-started server listens on baseURL's port (the `dev` script hardcodes 3000), so CI can
// run on a free port when something else on the agent already holds 3000.
const port = new URL(baseURL).port || "3000";

// Sharded CI run (Jenkins E2E_SHARDS > 1): each shard is a full stack of its own (Postgres + MinIO +
// `next dev`), and this process runs only its slice of the suite. E2E_SHARD is 1-based. Each shard
// also gets its own Next build folder (next.config.mjs reads SKILLY_NEXT_DIST_DIR), test-results
// folder and JUnit file, so parallel shards on one agent never write to the same place. Unset =
// the whole suite, exactly as before.
//
// Passes (E2E_PASS of E2E_PASS_TOTAL, ci/e2e-shard.sh): a stack's slice run as several Playwright
// invocations one after another, each starting a fresh dev server, because under webpack one
// server's compiled route graph grew until the kernel OOM-killed it. Pass p of P on stack shard s of
// S is Playwright shard (s-1)*P+p of S*P, so a stack's passes together cover exactly its contiguous
// slice. Passes share the stack's build folder (Turbopack's disk cache carries over), not its result
// folders.
function sliceOf(index: string | undefined, total: string | undefined) {
  const i = Number(index ?? 0);
  const n = Number(total ?? 0);
  return Number.isInteger(i) && Number.isInteger(n) && n > 1 && i >= 1 && i <= n ? { current: i, total: n } : null;
}
const stackShard = sliceOf(process.env.E2E_SHARD, process.env.E2E_SHARD_TOTAL);
const pass = sliceOf(process.env.E2E_PASS, process.env.E2E_PASS_TOTAL);
const shard =
  stackShard || pass
    ? {
        current: ((stackShard?.current ?? 1) - 1) * (pass?.total ?? 1) + (pass?.current ?? 1),
        total: (stackShard?.total ?? 1) * (pass?.total ?? 1),
      }
    : null;
const shardDir = [stackShard && `shard-${stackShard.current}`, pass && `pass-${pass.current}`].filter(Boolean).join("/");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  // Warm every route once before the first spec (see global-setup.ts): `next dev` compiles a
  // route on first hit, and paying that inside a spec's own budget was the suite's main flake.
  globalSetup: "./global-setup.ts",
  // `next dev` compiles each route on first hit; that compile can be slow, so give CI a generous
  // per-test budget. Locally (warm dev server) the tighter default is fine.
  timeout: process.env.CI ? 90_000 : 30_000,
  fullyParallel: true,
  shard,
  outputDir: shard ? `test-results/${shardDir}` : "test-results",
  // In CI, serialize: the dev server's compiler is a shared bottleneck, and many workers all
  // triggering first-compiles at once thrash it into navigation timeouts. One worker lets each
  // route compile once and stay cached for the rest of the run — slower but reliable. Locally
  // Playwright's default (parallel) is used against an already-warm dev server.
  workers: process.env.CI ? 1 : undefined,
  // A single retry in CI absorbs a first-compile that still overshoots; pairs with
  // trace-on-first-retry below.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: shard ? `results/${shardDir}/junit.xml` : "results/junit.xml" }]]
    : "html",
  // Per-assertion budget. Specs gate on the hydrated shell (helpers/ready.ts) and pair every
  // mutation with its response, so assertions rarely wait long — but a loaded CI agent still
  // needs more than the 5s default for a client-side navigation or a thread refetch.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  // Auto-manage the dev server. In CI (CI=1) always start a fresh one; locally reuse a dev server
  // the developer already has running. `next dev` must run — a production build refuses
  // SKILLY_DEV_AUTH=1 (instrumentation.ts), and dev auth is what the suite signs in with.
  webServer: {
    command: `pnpm --filter @skilly/web exec next dev --turbopack -p ${port}`,
    // SKILLY_E2E_DEV_SERVER=1: Turbopack's "full" memory eviction (next.config.mjs). Every route
    // the warm-up compiles stays in the build folder's disk cache and comes back from it, not from
    // a recompile, when a spec first requests it.
    // LEADERBOARD_CACHE_TTL_MS=0: the shared per-(window,sort) board cache (lib/leaderboard.ts) is
    // primed by /api/leaders on EVERY page load, so a spec that creates a request and then reads
    // the board through the UI would see a board computed before its own fixture for up to 60s.
    // INSTALL_TOKEN_ENC_KEY: a TEST-ONLY key so minted installs keep a recoverable copy and the §23
    // "Show install URL" step of already-installed.spec.ts runs (the caller's own key wins if set).
    env: {
      SKILLY_E2E_DEV_SERVER: "1",
      LEADERBOARD_CACHE_TTL_MS: "0",
      INSTALL_TOKEN_ENC_KEY: process.env.INSTALL_TOKEN_ENC_KEY ?? "c2tpbGx5LWUyZS1pbnN0YWxsLXRva2VuLWtleS0zMmI=",
      NODE_OPTIONS: devServerNodeOptions,
      ...(stackShard ? { SKILLY_NEXT_DIST_DIR: `.next-e2e-${stackShard.current}` } : {}),
    },
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
