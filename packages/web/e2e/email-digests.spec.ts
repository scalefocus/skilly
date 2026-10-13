// e2e: the §48 email-digest surfaces — the Profile "Email frequency" select (persisted via PATCH
// /api/me) and the Administration "Email digests" subsection of the Email notifications card,
// whose default frequency is what the Profile's "Organization default (…)" option names. Email
// delivery itself is covered by the worker integration tests, not here. Runs against the dev stack
// (SKILLY_DEV_AUTH=1, the dev user is a platform admin). Both tests mutate the dev user's row and a
// platform setting, so they run serially and restore what they change.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { clickAndAwait, gotoLoaded, gotoReady } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const frequency = (page: Page) => page.getByLabel("Email frequency");

async function resetDefaults(page: Page) {
  await page.request.patch("/api/me", { data: { emailNotifications: true, emailDigest: null } });
  await page.request.patch("/api/admin/settings", { data: { emailDigestsEnabled: true, emailDigestDefaultMode: "immediate" } });
}

test.describe("email digests (§48)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await resetDefaults(page);
  });
  test.afterEach(async ({ page }) => {
    await resetDefaults(page);
  });

  test("choosing Weekly digest on the Profile persists across reloads", async ({ page }) => {
    await gotoReady(page, "/profile");
    await expect(frequency(page)).toBeVisible();
    await expect(frequency(page)).toHaveValue(""); // Organization default
    await clickAndAwait(page, async () => { await frequency(page).selectOption("weekly"); }, "/api/me", { method: "PATCH" });
    await expect(page.getByTestId("email-frequency")).toContainText(/your time, on Mondays/);

    await gotoReady(page, "/profile");
    await expect(frequency(page)).toHaveValue("weekly");
  });

  test("an admin's default frequency names the Profile's organization-default option", async ({ page }) => {
    // The card header renders once GET /api/admin/email resolves (as in email-notifications.spec).
    await gotoLoaded(page, "/admin", "/api/admin/email");
    const header = page.locator('[data-last-card="email"] [data-card-header]');
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    const section = page.getByTestId("email-digest-settings");
    await expect(section).toBeVisible();
    await clickAndAwait(page, async () => { await section.getByLabel("Default frequency").selectOption("daily"); }, "/api/admin/settings", { method: "PATCH" });

    await gotoReady(page, "/profile");
    await expect(frequency(page).locator("option").first()).toHaveText("Organization default (Daily digest)");
  });
});
