// e2e: the skill detail page's Discussion card (SKILLY_SPEC.md §24 "Skill discussion"). The card
// is EXPANDED by default with one global localStorage collapse preference; posts a comment with a
// version pill, sees it render newest-first, then deletes it as a moderator (the dev user is a
// platform admin). Runs against the dev stack (SKILLY_DEV_AUTH=1) using the seeded, installable
// `global/pdf-tools` skill; opt-in, not part of the default `pnpm -r test`. Self-cleaning: the
// comment it posts is removed at the end.
import { test, expect, devSignIn } from "./fixtures";

test.describe("skill discussion (@global/pdf-tools)", () => {
  test("expanded by default → post a comment with a version pill → moderator delete", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools");

    // Expanded by default (§24) — no stored preference yet; the header shows the live count.
    const header = page.getByRole("button", { name: /^Discussion/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    await expect(header).toHaveAttribute("aria-expanded", "true");

    // Post a unique comment (the composer is the mention-capable editable, not a textarea).
    const body = `e2e discussion probe ${Date.now()}`;
    const composer = page.getByRole("textbox", { name: "Add to the discussion" });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill(body);
    await page.getByRole("button", { name: /^Post/ }).click();

    // It renders in the thread with a clickable version pill (vX.Y.Z).
    const comment = page.locator("section#discussion").getByText(body, { exact: false });
    await expect(comment).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("section#discussion .version-pill-btn").first()).toBeVisible();

    // Moderator delete (dev user is a platform admin). Accept the confirm() dialog.
    page.once("dialog", (d) => d.accept());
    // The row = the innermost div that holds BOTH the body text and its delete button.
    const row = page.locator("section#discussion div").filter({ hasText: body }).filter({ has: page.getByRole("button", { name: "delete" }) }).last();
    await row.getByRole("button", { name: "delete" }).click();
    await expect(page.locator("section#discussion").getByText(body, { exact: false })).toHaveCount(0, { timeout: 10_000 });
  });

  test("collapsing is remembered globally in localStorage; expanding clears it", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools");
    const header = page.getByRole("button", { name: /^Discussion/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    await expect(header).toHaveAttribute("aria-expanded", "true");

    // Collapse → the ONE global key is written (§24).
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBe("1");

    // A DIFFERENT skill's card honors the same preference on load.
    await page.goto("/skills/global/lint-fixer");
    const other = page.getByRole("button", { name: /^Discussion/ });
    await expect(other).toBeVisible({ timeout: 20_000 });
    await expect(other).toHaveAttribute("aria-expanded", "false");

    // Expanding any card clears the preference.
    await other.click();
    await expect(other).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBeNull();
  });

  test("#discussion deep link auto-expands even over a stored collapse, without overwriting it", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools");
    await page.evaluate(() => localStorage.setItem("skilly.discussionCollapsed", "1"));
    await page.goto("/skills/global/pdf-tools#discussion");
    const header = page.getByRole("button", { name: /^Discussion/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    await expect(header).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
    // …for this view only: the stored preference is untouched (§24).
    expect(await page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBe("1");
    await page.evaluate(() => localStorage.removeItem("skilly.discussionCollapsed"));
  });

  test("emoji picker stays on-screen on a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools#discussion");

    const composer = page.locator("section#discussion");
    const emojiBtn = composer.getByRole("button", { name: "Insert emoji" });
    await expect(emojiBtn).toBeVisible({ timeout: 20_000 });
    await emojiBtn.click();

    // The picker panel (the only open role=menu in the card) must fit within the viewport —
    // regression guard: it used to anchor right:0 and overflow past the left edge on mobile.
    const panel = composer.getByRole("menu");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  });
});
