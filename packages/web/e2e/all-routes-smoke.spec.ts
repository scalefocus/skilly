// e2e: a broad page-load net over every top-level route. Signed in as the dev admin (so
// admin-only routes resolve too), each page must render the app shell and surface no Next.js error
// boundary / runtime overlay. This is the cheap, wide safety net that catches a route that 500s or
// throws on load; the targeted specs assert each page's specific behaviour. Read-only.
import { authedTest as test, expect } from "./fixtures";

// /tokens intentionally redirects to /profile (kept for old bookmarks) — it still lands on a
// rendered shell, so it belongs in the net.
const ROUTES = [
  "/",
  "/catalog",
  "/catalog/marketplaces",
  "/marketplaces",
  "/installed",
  "/mcp",
  "/leaderboard",
  "/usage",
  "/requests",
  "/notifications",
  "/proposals",
  "/propose",
  "/tokens",
  "/audit",
  "/system-log",
  "/profile",
  "/quick-start",
  "/whats-new",
  "/admin",
];

test.describe("all-routes smoke", () => {
  for (const route of ROUTES) {
    test(`loads ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      // The app shell rendered — the colophon is present on every signed-in page. Generous timeout:
      // the first hit on a route pays the `next dev` on-demand compile.
      await expect(page.locator(".colophon-version")).toBeVisible({ timeout: 25_000 });
      // No error boundary / runtime overlay surfaced.
      await expect(
        page.getByText(/Unhandled Runtime Error|Application error|Internal Server Error/i),
      ).toHaveCount(0);
    });
  }
});
