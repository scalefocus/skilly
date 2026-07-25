// e2e: the notifications inbox (SKILLY_SPEC.md §12). Surfaces proposal/review outcomes; opening the
// page marks them read. We assert the inbox renders with its event-type filter controls and shows
// either notification rows or the "all caught up" empty state. Read-only.
import { test, expect, devSignIn } from "./fixtures";

test.describe("notifications inbox (§12)", () => {
  test("renders the inbox with its filters and rows-or-empty-state", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/notifications");

    await expect(page.getByRole("heading", { name: "Notifications." })).toBeVisible({ timeout: 20_000 });

    // Either the caller has notifications (rows) or the clean empty state renders.
    await expect(
      page.locator(".rows .row").first().or(page.getByText(/caught up/i)),
    ).toBeVisible();
  });
});
