// e2e: authentication gating + the signed-in shell (SKILLY_SPEC.md §3, §4). All catalog access is
// auth-required, so protected pages must NOT render their content to a signed-out visitor — the
// sidebar shows only a sign-in button and the navigation is hidden. After dev sign-in the shell
// flips: the nav appears, the account menu replaces the sign-in button, and platform-admin-only
// destinations (Administration, System log) are present for the seeded dev-admin. Runs against the
// dev stack (SKILLY_DEV_AUTH=1). Read-only — nothing to clean up.
import { test, expect, devSignIn } from "./fixtures";

const PROTECTED = ["/catalog", "/admin", "/proposals", "/usage", "/requests", "/audit"];

test.describe("access gating", () => {
  // Each protected route, unauthenticated, shows the sidebar sign-in affordance and hides the
  // signed-in navigation — proving the gate holds without leaking catalog content.
  for (const path of PROTECTED) {
    test(`signed out: ${path} is gated`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 20_000 });
      // The whole nav is signed-in-only; its absence confirms we are not authenticated.
      await expect(page.getByRole("link", { name: "Overview" })).toHaveCount(0);
    });
  }

  test("signed in: the shell exposes nav, the account menu and admin-only destinations", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/");

    // Scope to the sidebar — some page bodies also link to /catalog etc., which would otherwise
    // make a bare getByRole('link', { name }) ambiguous.
    const sidebar = page.locator("aside.sidebar");

    // Core navigation is present for any signed-in user.
    for (const label of ["Overview", "Catalog", "Propose a skill", "Review queue", "Leaderboard"]) {
      await expect(sidebar.getByRole("link", { name: label })).toBeVisible({ timeout: 20_000 });
    }

    // The sign-in button is gone; the account trigger (bottom-left) is present.
    await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    await expect(sidebar.locator(".user-trigger")).toBeVisible();

    // Platform-admin-only destinations — their presence also asserts the dev user's role.
    await expect(sidebar.getByRole("link", { name: "Administration" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "System log" })).toBeVisible();

    // The version colophon renders on every authed page (used as the "shell is up" signal
    // elsewhere in the suite).
    await expect(sidebar.locator(".colophon-version")).toBeVisible();
    await expect(sidebar.locator(".colophon-version")).toHaveText(/^v\d+\.\d+\.\d+/);
  });
});
