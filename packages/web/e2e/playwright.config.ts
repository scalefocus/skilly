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
import { defineConfig, devices, type Project } from "@playwright/test";
import { totalmem } from "node:os";
import { EXCLUSIVE, EXCLUSIVE_PROJECT, GROUPS, PARALLEL, PARALLEL_PROJECT, groupProject } from "./groups";

// Heap ceiling for the auto-started dev server. `next dev` defaults to half the machine's RAM and
// restarts itself at 80% of that, i.e. at 40% of RAM. Under webpack, with ~180 routes kept compiled,
// the dev compiler crossed that line twice per CI run and each restart discarded the warm-up.
// Turbopack keeps its compiled output outside the JS heap (and, for this server, on disk:
// next.config.mjs), so the heap now stays far below the line. If it ever grows again, do NOT answer
// that by raising the ceiling: V8 defers full collections while far below it, so a ceiling near RAM
// fills with garbage until the kernel OOM-kills the server (a 10.8 GB ceiling on a 16 GB CI agent
// did, mid-warm-up). Half of RAM, capped at 8 GB — the same cap ci/e2e-worker-plan.sh applies in
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

// Workers (SKILLY_SPEC.md §16 item 18). Under CI=1 the worker count is E2E_WORKERS (Jenkins:
// 1-16, default 4, capped by ci/e2e-worker-plan.sh), else 1 — the GitHub Actions job and any CI=1
// run that does not set it keep the old one-worker run. Locally Playwright's default applies.
function ciWorkers(): number {
  const n = Number(process.env.E2E_WORKERS ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error(`E2E_WORKERS must be a whole number from 1 to 16 (got "${process.env.E2E_WORKERS}")`);
  }
  return n;
}

// Projects come from the parallelism manifest (groups.ts): `exclusive` (one worker, alone),
// `group-<name>` (one worker each, files in order) and `parallel`. All run the same browser.
// E2E_PHASE (set by ci/e2e-run.sh) picks which ones this invocation defines: `exclusive` = phase 1,
// `shared` = phase 2 (every group + parallel). Two invocations, not a project dependency: Playwright
// skips every dependent project when a dependency fails, and a red exclusive spec must not hide the
// rest of the suite. Unset = all projects in one run (GitHub Actions, local).
const phase = process.env.E2E_PHASE ?? "";
if (phase !== "" && phase !== "exclusive" && phase !== "shared") {
  throw new Error(`E2E_PHASE must be "exclusive" or "shared" (got "${phase}")`);
}
const exactFiles = (files: readonly string[]) => files.map((f) => `**/${f}`);
const browser = { ...devices["Desktop Chrome"] };
const exclusiveProject: Project = {
  name: EXCLUSIVE_PROJECT,
  testMatch: exactFiles(EXCLUSIVE),
  fullyParallel: false,
  workers: 1,
  use: browser,
};
const sharedProjects: Project[] = [
  ...Object.entries(GROUPS).map(([name, group]): Project => ({
    name: groupProject(name),
    testMatch: exactFiles(group.specs),
    fullyParallel: false,
    workers: 1,
    use: browser,
  })),
  { name: PARALLEL_PROJECT, testMatch: exactFiles(PARALLEL), fullyParallel: true, use: browser },
];
const projects =
  phase === "exclusive" ? [exclusiveProject] : phase === "shared" ? sharedProjects : [exclusiveProject, ...sharedProjects];
// Each phase writes its own evidence and JUnit, so phase 2 never overwrites phase 1's.
const phaseDir = phase ? `/${phase}` : "";

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
  outputDir: `test-results${phaseDir}`,
  // In CI, E2E_WORKERS workers (ciWorkers above). Under webpack the dev server's one compiler was a
  // shared bottleneck and several workers thrashed it into navigation timeouts, so CI ran one.
  // Turbopack compiles routes independently and restores warmed ones from its disk cache, and each
  // worker signs in as its own user (fixtures.ts), so the Jenkins run now drives several. Specs
  // that share state are kept apart by the projects above. Locally Playwright's default applies.
  workers: process.env.CI ? ciWorkers() : undefined,
  // A single retry in CI absorbs a first-compile that still overshoots; pairs with
  // trace-on-first-retry below.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: `results${phaseDir}/junit.xml` }]]
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
    // AI_ALLOW_PRIVATE_BASE_URL=1: the AI specs' stub provider listens on 127.0.0.1, which the
    // §49.11 egress guard refuses otherwise (ci/e2e-run.sh sets it for the server it starts).
    env: {
      SKILLY_E2E_DEV_SERVER: "1",
      LEADERBOARD_CACHE_TTL_MS: "0",
      INSTALL_TOKEN_ENC_KEY: process.env.INSTALL_TOKEN_ENC_KEY ?? "c2tpbGx5LWUyZS1pbnN0YWxsLXRva2VuLWtleS0zMmI=",
      AI_ALLOW_PRIVATE_BASE_URL: "1",
      NODE_OPTIONS: devServerNodeOptions,
    },
    url: baseURL,
    timeout: 120_000,
    // Locally, reuse a dev server the developer already runs. Under CI=1 start a fresh one, unless
    // E2E_EXTERNAL_SERVER=1: ci/e2e-run.sh starts ONE dev server itself and both phases drive it.
    reuseExistingServer: !process.env.CI || process.env.E2E_EXTERNAL_SERVER === "1",
    stdout: "pipe",
    stderr: "pipe",
  },
  projects,
});
