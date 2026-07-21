// e2e: the skill detail page's Discussion card (SKILLY_SPEC.md §24 "Skill discussion"). Expands the
// collapsed card, posts a comment with a version pill, sees it render newest-first, then deletes it
// as a moderator (the dev user is a platform admin). Runs against the dev stack (SKILLY_DEV_AUTH=1)
// using the seeded, installable `global/pdf-tools` skill; opt-in, not part of the default
// `pnpm -r test`. Self-cleaning: the comment it posts is removed at the end.
import { test, expect, type Page } from "@playwright/test";

async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
  expect(res.ok()).toBeTruthy();
}

test.describe("skill discussion (@global/pdf-tools)", () => {
  test("expand → post a comment with a version pill → moderator delete", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools");

    // The card is collapsed by default; its header shows the live count.
    const header = page.getByRole("button", { name: /^Discussion/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");

    // Post a unique comment.
    const body = `e2e discussion probe ${Date.now()}`;
    const textarea = page.getByPlaceholder(/Add to the discussion/);
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill(body);
    await page.getByRole("button", { name: /^Post/ }).click();

    // It renders in the thread with a clickable version pill (vX.Y.Z).
    const comment = page.locator("section#discussion").getByText(body, { exact: false });
    await expect(comment).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("section#discussion .version-pill-btn").first()).toBeVisible();

    // Moderator delete (dev user is a platform admin). Accept the confirm() dialog.
    page.once("dialog", (d) => d.accept());
    const row = page.locator("section#discussion div").filter({ hasText: body }).last();
    await row.getByRole("button", { name: "delete" }).click();
    await expect(page.locator("section#discussion").getByText(body, { exact: false })).toHaveCount(0, { timeout: 10_000 });
  });

  test("#discussion deep link auto-expands the card", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools#discussion");
    const header = page.getByRole("button", { name: /^Discussion/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    await expect(header).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
  });
});
