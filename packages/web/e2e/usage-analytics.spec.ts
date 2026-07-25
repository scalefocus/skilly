// e2e: the usage analytics page (SKILLY_SPEC.md §19). View/install tendencies for skills the user
// owns; platform admins see the platform aggregate. We assert the page renders with its range
// controls and the always-present "Skills" section. Read-only. (The header-search filter on this
// page is covered by usage-header-search.spec.ts.)
import { test, expect, devSignIn } from "./fixtures";

test.describe("usage analytics (§19)", () => {
  test("renders the usage dashboard with its range controls and skills section", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/usage");

    await expect(page.getByRole("heading", { name: "Usage." })).toBeVisible({ timeout: 20_000 });
    // The per-skill section header is always rendered once the page loads.
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
    // The chart-range toggle group is present.
    await expect(page.getByRole("group", { name: "Chart range" })).toBeVisible();
  });
});
