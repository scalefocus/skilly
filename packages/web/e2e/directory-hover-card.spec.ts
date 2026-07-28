// e2e: the directory hover card on avatar bubbles (SKILLY_SPEC.md §28). Hover (or focus) any
// avatar and a floating card shows that person's Entra job title, department and office alongside
// their name and email; Escape and pointer-out dismiss it; the card itself is hoverable so its
// mailto link is clickable; and the profile opt-out collapses it to "No directory information".
// Runs against the dev stack (SKILLY_DEV_AUTH=1) using the seeded dev admin. Opt-in, not part of
// the default `pnpm -r test`.
import { test, expect, devSignIn, type Page } from "./fixtures";

const bubble = (page: Page) => page.getByRole("button", { name: "Dev Admin — profile" });
const card = (page: Page) => page.getByRole("dialog", { name: /Dev Admin — profile/ });

test.describe("directory hover card (§28)", () => {
  test("hovering an avatar shows title, department, office and a mailto link", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/profile");

    const b = bubble(page);
    // First navigation on a dev server pays the on-demand route compile — allow generous time.
    await expect(b).toBeVisible({ timeout: 20_000 });
    await expect(card(page)).toHaveCount(0); // nothing until hovered — the fetch is lazy

    await b.hover();
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c.getByText("Platform Engineer")).toBeVisible();
    await expect(c.getByText("Engineering")).toBeVisible();
    await expect(c.getByText("Sofia")).toBeVisible();
    await expect(c.getByRole("link", { name: "dev@skilly.local" })).toHaveAttribute("href", "mailto:dev@skilly.local");

    // The pointer can travel into the card without it closing (that's what makes the link usable).
    await c.hover();
    await expect(c).toBeVisible();

    // Moving away closes it.
    await page.getByRole("heading", { name: "Profile." }).hover();
    await expect(c).toHaveCount(0);
  });

  test("keyboard: focus opens the card, Escape closes it", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/profile");

    const b = bubble(page);
    await expect(b).toBeVisible({ timeout: 20_000 });

    await b.focus(); // the bubble is a tab stop — no pointer needed
    await expect(card(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(b).toBeFocused(); // focus returns to the bubble, not to the top of the page
  });

  test("the profile opt-out collapses the card to “No directory information”", async ({ page }) => {
    await devSignIn(page);
    const patch = (directoryHidden: boolean) =>
      page.request.patch("/api/me", { data: { directoryHidden } });

    try {
      await patch(true);
      await page.goto("/profile");
      const b = bubble(page);
      await expect(b).toBeVisible({ timeout: 20_000 });

      await b.hover();
      const c = card(page);
      await expect(c).toBeVisible();
      await expect(c.getByText("No directory information")).toBeVisible();
      await expect(c.getByText("Platform Engineer")).toHaveCount(0);
      // Name and email are NOT part of the opt-out.
      await expect(c.getByRole("link", { name: "dev@skilly.local" })).toBeVisible();
    } finally {
      await patch(false); // never leave the shared dev user opted out
    }
  });
});
