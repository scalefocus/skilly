// e2e: the directory hover card on avatar bubbles (SKILLY_SPEC.md §28). Hover (or focus) any
// avatar and a floating card shows that person's Entra job title, department and office alongside
// their name and email; Escape and pointer-out dismiss it; the card itself is hoverable so its
// mailto link is clickable; and the profile opt-out collapses it to "No directory information".
// Runs against the dev stack (SKILLY_DEV_AUTH=1) using the seeded dev admin. Opt-in, not part of
// the default `pnpm -r test`.
//
// Hardening (helpers/ready.ts): every interaction waits for the hydrated shell first — the card's
// hover-intent timer and lazy fetch are React handlers, and a hover delivered to server markup
// does nothing. The opening hover is paired with the card's own GET so the assertion runs after
// the data, not after a guess.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { clickAndAwait, gotoReady } from "./helpers/ready";

// Scoped to <main>: the topbar account menu also renders this person's bubble, and its own
// trigger button absorbs the nested bubble's label into its accessible name — so an unscoped
// lookup matches three elements on /profile and trips strict mode. The page's own bubble is the
// one this spec is about.
const bubble = (page: Page) => page.getByRole("main").getByRole("button", { name: "Dev Admin — profile" });
const card = (page: Page) => page.getByRole("dialog", { name: /Dev Admin — profile/ });
// The card's data is fetched lazily on the first open (`GET /api/users/:id/card`, DirectoryCard.tsx).
const CARD_API = /\/api\/users\/[^/]+\/card/;

test.describe("directory hover card (§28)", () => {
  test("hovering an avatar shows title, department, office and a mailto link", async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/profile");

    const b = bubble(page);
    await expect(b).toBeVisible();
    await expect(card(page)).toHaveCount(0); // nothing until hovered — the fetch is lazy

    // Hover intent (300 ms) then the lazy GET — wait for the round-trip, not a timer.
    await clickAndAwait(page, () => b.hover(), CARD_API);
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c.getByText("Platform Engineer")).toBeVisible();
    await expect(c.getByText("Engineering")).toBeVisible();
    await expect(c.getByText("Sofia")).toBeVisible();
    await expect(c.getByRole("link", { name: "dev@skilly.local" })).toHaveAttribute("href", "mailto:dev@skilly.local");

    // The pointer can travel into the card without it closing (that's what makes the link usable).
    await c.hover();
    await expect(c).toBeVisible();

    // Moving away closes it. Park the pointer on the page's own heading — a stable, non-interactive
    // element that is neither the bubble nor the card.
    await page.getByRole("heading", { name: "Profile." }).hover();
    await expect(c).toHaveCount(0);
  });

  test("keyboard: focus opens the card, Escape closes it", async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/profile");

    const b = bubble(page);
    await expect(b).toBeVisible();

    await clickAndAwait(page, () => b.focus(), CARD_API); // the bubble is a tab stop — no pointer needed
    await expect(card(page)).toBeVisible();

    // Escape is handled by the TRIGGER's keydown (DirectoryCard.tsx) - deliver it there, whatever
    // element holds focus once the card has rendered.
    await b.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(b).toBeFocused(); // focus returns to the bubble, not to the top of the page
  });

  test("the profile opt-out collapses the card to “No directory information”", async ({ page }) => {
    await devSignIn(page);
    const patch = (directoryHidden: boolean) =>
      page.request.patch("/api/me", { data: { directoryHidden } });

    try {
      await patch(true);
      await gotoReady(page, "/profile");
      const b = bubble(page);
      await expect(b).toBeVisible();

      await clickAndAwait(page, () => b.hover(), CARD_API);
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
