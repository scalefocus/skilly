// e2e: the community leaderboard (SKILLY_SPEC.md §21). Ranks contributors by total installs of the
// skills they've shipped, capped at the fixed top-100 display limit. We assert the page renders,
// its "Rank by" controls are present, and it shows either seeded contributor rows or the empty
// state — and that the display never exceeds the top-100 cap. Read-only.
import { test, expect, devSignIn } from "./fixtures";

test.describe("leaderboard (§21)", () => {
  test("renders ranked contributors (or the empty state) within the top-100 cap", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/leaderboard");

    await expect(page.getByRole("heading", { name: "Leaderboard." })).toBeVisible({ timeout: 20_000 });

    // The ranking controls are always present regardless of data.
    await expect(page.getByRole("button", { name: "Installs" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skills adopted" })).toBeVisible();

    // Either seeded contributor rows or a clean empty state — the data region rendered without error.
    await expect(
      page.locator(".lb-row").first().or(page.getByText(/No contributors yet/i)),
    ).toBeVisible();

    // The fixed top-100 display cap is never exceeded.
    expect(await page.locator(".lb-row").count()).toBeLessThanOrEqual(100);
  });
});
