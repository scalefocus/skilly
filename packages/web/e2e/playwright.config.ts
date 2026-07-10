// Playwright config for skilly UI smoke tests. Lives outside `src` so it is excluded from
// the Next.js typecheck/build. Run against an already-running web server:
//
//   pnpm --filter @skilly/web dev          # in one terminal (http://localhost:3000)
//   npx playwright install --with-deps      # one-time: fetch browsers
//   pnpm --filter @skilly/web e2e           # in another
//
// Point at a different target with PLAYWRIGHT_BASE_URL. CI runs this opt-in (browsers + a
// live stack are required), so it is NOT part of the default `pnpm -r test`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
