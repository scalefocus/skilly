// e2e: the notifications inbox (SKILLY_SPEC.md §12). Surfaces proposal/review outcomes; opening the
// page marks them read. We assert the inbox renders with its event-type filter controls and shows
// either notification rows or the "all caught up" empty state, and walk the collapsible Type row:
// collapsed by default, the open/closed choice (and only that) remembered per browser, and a
// collapsed row with a selection still showing — and clearing — why the inbox is filtered.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { clickAndAwait, gotoLoaded, reloadReady } from "./helpers/ready";

const TYPES_OPEN = "skilly.notifications.types-open";

const toggle = (page: Page) => page.locator("button.facet-row-toggle").filter({ hasText: "Type" });
const chipbox = (page: Page) => page.locator("#facet-row-notification-types");
const chips = (page: Page) => chipbox(page).locator(".facet");
const summary = (page: Page) => page.locator(".facet-row-summary");
const storedOpen = (page: Page) => page.evaluate((k) => localStorage.getItem(k), TYPES_OPEN);

test.describe("notifications inbox (§12)", () => {
  test("renders the inbox with its filters and rows-or-empty-state", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/notifications");

    await expect(page.getByRole("heading", { name: "Notifications." })).toBeVisible({ timeout: 20_000 });
    await expect(toggle(page)).toBeVisible();

    // Either the caller has notifications (rows) or the clean empty state renders.
    await expect(
      page.locator(".rows .row").first().or(page.getByText(/caught up/i)),
    ).toBeVisible();
  });

  test("the Type row starts collapsed, remembers only its open/closed choice, and explains a collapsed selection", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/notifications", "/api/notifications?offset=0");
    await page.evaluate((k) => localStorage.removeItem(k), TYPES_OPEN);
    await reloadReady(page);

    // Collapsed on a first visit: the chips are mounted (the row animates) but unreachable.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    expect(await chipbox(page).evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    expect((await chipbox(page).boundingBox())?.height ?? -1).toBe(0);
    // The header counts every notification type — one chip each.
    const typeCount = await chips(page).count();
    expect(typeCount).toBeGreaterThan(10);
    await expect(toggle(page)).toContainText(`· ${typeCount}`);
    await expect(summary(page)).toHaveCount(0);

    // Expanding reveals the chips, and the choice survives a reload.
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(chips(page).first()).toBeVisible();
    expect(await storedOpen(page)).toBe("1");
    await reloadReady(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

    // Pick two types (each a server-side re-query), then collapse: the summary names the count.
    await clickAndAwait(page, () => chips(page).nth(0).click(), "/api/notifications?offset=0&types=");
    await clickAndAwait(page, () => chips(page).nth(1).click(), "/api/notifications?offset=0&types=");
    await expect(chipbox(page).locator(".facet-on")).toHaveCount(2);
    await expect(summary(page)).toHaveCount(0); // open: the chips show the selection themselves
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    expect(await storedOpen(page)).toBe("0");
    await expect(summary(page)).toContainText("2 selected");
    // Collapsing never touches the selection.
    await expect(chipbox(page).locator(".facet-on")).toHaveCount(2);

    // Clearing from the summary drops the filter and leaves the row collapsed.
    await clickAndAwait(page, () => summary(page).getByRole("button", { name: "✕ clear" }).click(), /\/api\/notifications\?offset=0$/);
    await expect(summary(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(chipbox(page).locator(".facet-on")).toHaveCount(0);

    // The collapsed choice is remembered…
    await reloadReady(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    // …but a selection never is: pick one, reload, and the inbox arrives unfiltered.
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await clickAndAwait(page, () => chips(page).nth(0).click(), "/api/notifications?offset=0&types=");
    await expect(chipbox(page).locator(".facet-on")).toHaveCount(1);
    await reloadReady(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(chipbox(page).locator(".facet-on")).toHaveCount(0);

    await page.evaluate((k) => localStorage.removeItem(k), TYPES_OPEN);
  });
});
