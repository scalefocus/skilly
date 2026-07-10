// e2e: the "Featured skills" homepage spotlight (SKILLY_SPEC.md §7). A platform admin spotlights a
// skill from its detail page (Spotlight → ✓ Spotlighted), it then appears in the "Featured skills"
// section on the home page, and un-spotlighting removes it again. Runs against the dev stack
// (SKILLY_DEV_AUTH=1, a platform-admin dev user) using the seeded, installable `global/pdf-tools`
// skill; opt-in, not part of the default `pnpm -r test`. Self-cleaning: it always leaves the skill
// un-spotlighted.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as
// e2e/shots.mjs / new-version-metadata.spec.ts. Shares the page cookie jar.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
  expect(res.ok()).toBeTruthy();
}

test.describe("featured skills spotlight (@global/pdf-tools)", () => {
  test("spotlight a skill → it appears in Featured on the home page → un-spotlight removes it", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/skills/global/pdf-tools");

    const spotlight = page.getByRole("button", { name: "Spotlight", exact: true });
    const spotlighted = page.getByRole("button", { name: /Spotlighted/ });

    // The Spotlight control is platform-admin only — its presence also asserts the dev user's role.
    // First navigation on a dev server pays the on-demand route compile, so allow generous time.
    await expect(spotlight.or(spotlighted)).toBeVisible({ timeout: 20_000 });

    // Normalize to a known un-spotlighted starting state.
    if (await spotlighted.isVisible()) {
      await spotlighted.click();
      await expect(spotlight).toBeVisible({ timeout: 10_000 });
    }

    // Spotlight it → the toggle flips to the pinned state.
    await spotlight.click();
    await expect(spotlighted).toBeVisible({ timeout: 10_000 });

    // Home page now shows the Featured section containing PDF Tools.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Featured skills" })).toBeVisible({ timeout: 20_000 });
    const featuredSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Featured skills" }) });
    await expect(featuredSection.locator('a[href="/skills/global/pdf-tools"]')).toBeVisible();

    // Placement (SKILLY_SPEC.md §7): Featured sits immediately below the stats row and above the
    // "Installing is one command." explainer.
    const statsBox = await page.locator("section.stat-row").boundingBox();
    const featuredBox = await page.getByRole("heading", { name: "Featured skills" }).boundingBox();
    const installBox = await page.getByRole("heading", { name: "Installing is one command." }).boundingBox();
    expect(statsBox!.y).toBeLessThan(featuredBox!.y);
    expect(featuredBox!.y).toBeLessThan(installBox!.y);

    // Un-spotlight (cleanup) → the pin is removed again.
    await page.goto("/skills/global/pdf-tools");
    await expect(spotlighted).toBeVisible({ timeout: 20_000 });
    await spotlighted.click();
    await expect(spotlight).toBeVisible({ timeout: 10_000 });
  });
});
