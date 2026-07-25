// Playwright config for the skilly e2e suite. Lives outside `src` so it is excluded from the
// Next.js typecheck/build. The suite runs against the DEV stack (SKILLY_DEV_AUTH=1) — a live web
// server + a migrated & seeded Postgres + MinIO. It is opt-in (browsers + a live stack required),
// so it is NOT part of the default `pnpm -r test`; CI runs it behind a gate (Jenkins RUN_E2E_TESTS
// / the GitHub Actions `e2e` job).
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

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  // `next dev` (webpack) compiles each route on first hit; that compile can be slow, so give CI a
  // generous per-test budget. Locally (warm dev server) the tighter default is fine.
  timeout: process.env.CI ? 90_000 : 30_000,
  fullyParallel: true,
  // In CI, serialize: the webpack dev compiler is a shared bottleneck, and many workers all
  // triggering first-compiles at once thrash it into navigation timeouts. One worker lets each
  // route compile once and stay cached for the rest of the run — slower but reliable. Locally
  // Playwright's default (parallel) is used against an already-warm dev server.
  workers: process.env.CI ? 1 : undefined,
  // A single retry in CI absorbs a first-compile that still overshoots; pairs with
  // trace-on-first-retry below.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "results/junit.xml" }]]
    : "html",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  // Auto-manage the dev server. In CI (CI=1) always start a fresh one; locally reuse a dev server
  // the developer already has running. `next dev` must run — a production build refuses
  // SKILLY_DEV_AUTH=1 (instrumentation.ts), and dev auth is what the suite signs in with.
  webServer: {
    command: "pnpm --filter @skilly/web dev",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
