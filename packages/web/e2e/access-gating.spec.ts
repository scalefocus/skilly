// e2e: authentication gating + the signed-in shell (SKILLY_SPEC.md §3, §4). All catalog access is
// auth-required, so protected pages must NOT render their content to a signed-out visitor — the
// sidebar shows only a sign-in button and the navigation is hidden. After dev sign-in the shell
// flips: the nav appears, the account menu replaces the sign-in button, and platform-admin-only
// destinations (Administration, System log) are present for the seeded dev-admin. Runs against the
// dev stack (SKILLY_DEV_AUTH=1). Read-only — nothing to clean up.
import { test, expect, devSignIn } from "./fixtures";
import { gotoReady, reloadReady } from "./helpers/ready";

const PROTECTED = ["/catalog", "/admin", "/proposals", "/usage", "/requests", "/audit", "/mcp-server"];

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
    for (const label of ["Overview", "Catalog", "Propose skills", "Review queue", "Leaderboard"]) {
      await expect(sidebar.getByRole("link", { name: label })).toBeVisible({ timeout: 20_000 });
    }

    // The sign-in button is gone; the account trigger (bottom-left) is present.
    await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    await expect(sidebar.locator(".user-trigger")).toBeVisible();

    // Platform-admin-only destinations — their presence also asserts the dev user's role. They sit
    // in the collapsible Administration group (§71), which a fresh browser shows collapsed on "/".
    const group = sidebar.getByRole("button", { name: /^Administration/ });
    await expect(group).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });
    await group.click();
    await expect(sidebar.getByRole("link", { name: "Platform administration" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "System log" })).toBeVisible();

    // The version colophon renders on every authed page (used as the "shell is up" signal
    // elsewhere in the suite).
    await expect(sidebar.locator(".colophon-version")).toBeVisible();
    await expect(sidebar.locator(".colophon-version")).toHaveText(/^v\d+\.\d+\.\d+/);
  });

  test("signed in: the admin pages sit in a collapsible Administration group (§71)", async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/");
    const sidebar = page.locator("aside.sidebar");
    const group = sidebar.getByRole("button", { name: /^Administration/ });
    const items = sidebar.locator("#nav-admin-items a");

    // A fresh browser has no stored choice and "/" is outside the group: collapsed, items hidden.
    await expect(group).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });
    await expect(items.first()).toBeHidden();

    // Opening shows the eight items, settings first (§71.2). Usage stays in the main nav.
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(items.first()).toBeVisible();
    // The label is the link's own text node; a count badge (<sup>) beside it is left out.
    const labels = await items.evaluateAll((els) =>
      els.map((el) => Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim()),
    );
    expect(labels).toEqual([
      "Platform administration",
      "Namespace administration",
      "Audit log",
      "System log",
      "Monitoring",
      "Feature ideas",
      "Search gaps",
      "Signing",
    ]);
    await expect(sidebar.getByRole("link", { name: "Usage" })).toBeVisible();
    await expect(sidebar.locator("#nav-admin-items").getByRole("link", { name: "Usage" })).toHaveCount(0);

    // The choice is remembered in this browser across a reload (§71.4).
    await reloadReady(page);
    await expect(group).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });

    // Collapse it, then land on a page inside the group: it opens itself again.
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await gotoReady(page, "/admin/ideas");
    await expect(group).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
    // Longest prefix: only Feature ideas lights up, not Platform administration (/admin).
    await expect(sidebar.getByRole("link", { name: "Feature ideas" })).toHaveClass(/\bactive\b/);
    await expect(sidebar.getByRole("link", { name: "Platform administration" })).not.toHaveClass(/\bactive\b/);
    await expect(group).not.toHaveClass(/\bactive\b/);

    // Collapsing on one of its pages gives the header the active highlight.
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await expect(group).toHaveClass(/\bactive\b/);
  });
});
