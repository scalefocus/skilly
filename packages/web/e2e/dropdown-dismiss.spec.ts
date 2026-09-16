// e2e: the skill-detail split-button dropdowns must dismiss on an outside click OR Escape — not
// only when a menu item is chosen or the caret is re-clicked. Covers both split-buttons that share
// the dismiss handler: the install "version" picker (Install latest / Install v‹x›, §23) and the
// Pointer "download format" menu (.skill / .tar.gz, §6/§10). Clicking a NON-focusable element (a
// heading) is the exact case the former onBlur handler missed. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) using the seeded `global/pdf-tools` (hosted) and `global/web-scraper`
// (pointer) skills; opt-in, not part of the default `pnpm -r test`.
//
// Hardening (helpers/ready.ts): the dismiss handler is a document-level `mousedown` listener that
// React attaches in an effect — a click delivered before hydration neither opens nor closes
// anything. Each test starts from the hydrated shell with the skill's detail JSON already loaded.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { gotoLoaded } from "./helpers/ready";

// A non-focusable element outside both dropdowns — clicking it must still dismiss an open menu.
const outside = (page: Page) => page.getByRole("heading", { name: "Install", exact: true });

test.describe("install version split-button dismissal (@global/pdf-tools)", () => {
  // The version menu is the role=menu containing the "Install latest" option (distinct from the
  // Pointer download menu, whose options are .skill / .tar.gz).
  const versionMenu = (page: Page) => page.getByRole("menu").filter({ hasText: "Install latest" });
  const caret = (page: Page) => page.getByRole("button", { name: "Choose a version" });

  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    // The install form (and its version split-button) renders from the detail JSON.
    await gotoLoaded(page, "/skills/global/pdf-tools", /\/api\/skills\/global\/pdf-tools$/);
    await expect(caret(page)).toBeVisible();
    await expect(outside(page)).toBeVisible();
  });

  test("an outside click closes the version dropdown", async ({ page }) => {
    await caret(page).click();
    await expect(versionMenu(page)).toBeVisible();
    await outside(page).click();
    await expect(versionMenu(page)).toHaveCount(0);
  });

  test("Escape closes the version dropdown", async ({ page }) => {
    await caret(page).click();
    await expect(versionMenu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(versionMenu(page)).toHaveCount(0);
  });
});

test.describe("pointer download-format split-button dismissal (@global/web-scraper)", () => {
  // The download menu is the role=menu containing the .tar.gz option.
  const downloadMenu = (page: Page) => page.getByRole("menu").filter({ hasText: ".tar.gz" });
  const caret = (page: Page) => page.getByRole("button", { name: "Choose a download format" });

  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/skills/global/web-scraper", /\/api\/skills\/global\/web-scraper$/);
    await expect(caret(page)).toBeVisible();
    await expect(outside(page)).toBeVisible();
  });

  test("an outside click closes the download-format dropdown", async ({ page }) => {
    await caret(page).click();
    await expect(downloadMenu(page)).toBeVisible();
    await outside(page).click();
    await expect(downloadMenu(page)).toHaveCount(0);
  });

  test("Escape closes the download-format dropdown", async ({ page }) => {
    await caret(page).click();
    await expect(downloadMenu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(downloadMenu(page)).toHaveCount(0);
  });
});
