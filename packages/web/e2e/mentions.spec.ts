// e2e: mentions (SKILLY_SPEC.md §24 "Mentions", §10 people mode). Drives the composer's `@`/`#`
// pickers with real keystrokes on the seeded skill discussion — Enter SELECTS while the picker is
// open (never sends), the picked mention lands as an atomic chip, the posted message renders
// linked chips — and the header search's leading-`@` people mode. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) with db/seed.dev.sql (Alice Chen / Bob Ng / global/pdf-tools). Self-cleaning.
import { test, expect, devSignIn } from "./fixtures";

test.describe("mentions (§24)", () => {
  test("composer: @ picker → Enter selects an atomic chip → post renders linked chips", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/lint-fixer");

    const card = page.locator("section#discussion");
    const composer = page.getByRole("textbox", { name: "Add to the discussion" });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();

    // Type a message with an @-trigger; the caret-anchored people picker opens.
    await page.keyboard.type(`e2e mention probe ${Date.now()} for @alice ch`, { delay: 15 });
    const picker = page.locator("#mention-picker");
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(picker.getByText("Alice Chen")).toBeVisible();

    // Enter SELECTS (never sends): the run becomes one atomic chip; nothing was posted.
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    const chip = composer.locator("[data-mention]");
    await expect(chip).toHaveText("@Alice Chen");
    await expect(card.getByText("No comments yet", { exact: false })).toBeVisible(); // not sent

    // Backspace after the trailing space removes the WHOLE chip (atomic), then undo by re-picking.
    await page.keyboard.press("Backspace"); // the trailing space
    await page.keyboard.press("Backspace"); // the chip, as one unit
    await expect(composer.locator("[data-mention]")).toHaveCount(0);
    await page.keyboard.type("@alice ch", { delay: 15 });
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(composer.locator("[data-mention]")).toHaveCount(1);

    // Add a # skill mention the same way.
    await page.keyboard.type("see #pdf to", { delay: 15 });
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(picker.getByText("PDF Tools")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(composer.locator("[data-mention]")).toHaveCount(2);

    // Post → the message renders BOTH chips, linked (§24 rendering).
    await card.getByRole("button", { name: /^Post/ }).click();
    const userChip = card.locator(".md a.mention-chip-user");
    const skillChip = card.locator(".md a.mention-chip-skill");
    await expect(userChip).toBeVisible({ timeout: 10_000 });
    await expect(userChip).toHaveText("@Alice Chen");
    await expect(userChip).toHaveAttribute("href", /\/catalog\?maintainer=.+&by=Alice(%20| )Chen/);
    await expect(skillChip).toHaveText("PDF Tools");
    await expect(skillChip).toHaveAttribute("href", "/skills/global/pdf-tools");

    // The reminder line sits under the composer (§24, all four composers).
    await expect(card.getByText("# to mention a skill · @ to mention someone")).toBeVisible();

    // Clean up (dev user is a platform admin → moderator delete).
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "delete" }).first().click();
    await expect(card.locator(".md a.mention-chip-user")).toHaveCount(0, { timeout: 10_000 });
  });

  test("escape dismisses the picker and Enter then sends normally", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/lint-fixer");
    const card = page.locator("section#discussion");
    const composer = page.getByRole("textbox", { name: "Add to the discussion" });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();

    const body = `e2e esc probe ${Date.now()} @alice ch`;
    await page.keyboard.type(body, { delay: 15 });
    const picker = page.locator("#mention-picker");
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    // With the picker dismissed, Enter posts the literal text (no chip).
    await page.keyboard.press("Enter");
    const posted = card.getByText(body, { exact: false });
    await expect(posted).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".md [data-mention], .md .mention-chip")).toHaveCount(0);

    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "delete" }).first().click();
    await expect(card.getByText(body, { exact: false })).toHaveCount(0, { timeout: 10_000 });
  });

  test("header search people mode: leading @ lists people; picking opens their skills (§10)", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/");
    const box = page.getByRole("textbox", { name: "Search skills" });
    await box.click();
    await box.fill("@alice ch");

    const row = page.locator(".search-ac-item").filter({ hasText: "Alice Chen" });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("alice@org"); // avatar row carries the email
    await row.click();

    await expect(page).toHaveURL(/\/catalog\?maintainer=.+&by=Alice(%20| )Chen/);
    await expect(page.getByText("Skills maintained by Alice Chen", { exact: false })).toBeVisible({ timeout: 10_000 });
  });
});
