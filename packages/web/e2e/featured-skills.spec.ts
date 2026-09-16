// e2e: the "Featured skills" homepage spotlight (SKILLY_SPEC.md §7). A platform admin spotlights a
// skill from its detail page (Spotlight → ✓ Spotlighted), it then appears in the "Featured skills"
// section on the home page, and un-spotlighting removes it again. Runs against the dev stack
// (SKILLY_DEV_AUTH=1, a platform-admin dev user) using the seeded, installable `global/pdf-tools`
// skill; opt-in, not part of the default `pnpm -r test`. Self-cleaning: it always leaves the skill
// un-spotlighted.
//
// Hardening (helpers/ready.ts): the starting state is normalized through the API (not by reading
// the UI and clicking), each toggle click is paired with its POST /feature and the detail refetch
// `act()` issues afterwards, and the home page is asserted after its /api/skills/featured arrives.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { awaitApi, clickAndAwait, gotoLoaded } from "./helpers/ready";

const SKILL = "/skills/global/pdf-tools";
const DETAIL = /\/api\/skills\/global\/pdf-tools$/;
const setFeatured = (page: Page, featured: boolean) =>
  page.request.post("/api/skills/global/pdf-tools/feature", { data: { featured } });

// Mutates the shared dev catalog's spotlight — never interleave with another spotlight test.
test.describe.configure({ mode: "serial" });

test.describe("featured skills spotlight (@global/pdf-tools)", () => {
  test("spotlight a skill → it appears in Featured on the home page → un-spotlight removes it", async ({ page }) => {
    await devSignIn(page);
    // Known starting state, set server-side.
    expect((await setFeatured(page, false)).ok()).toBeTruthy();

    try {
      await gotoLoaded(page, SKILL, DETAIL);
      const spotlight = page.getByRole("button", { name: "Spotlight", exact: true });
      const spotlighted = page.getByRole("button", { name: /Spotlighted/ });
      // The Spotlight control is platform-admin only — its presence also asserts the dev user's role.
      await expect(spotlight).toBeVisible();

      // Spotlight it: POST /feature, then act() refetches the detail → the toggle flips.
      let refreshed = awaitApi(page, DETAIL);
      await clickAndAwait(page, () => spotlight.click(), "/feature", { method: "POST" });
      await refreshed;
      await expect(spotlighted).toBeVisible();

      // Home page now shows the Featured section containing PDF Tools.
      await gotoLoaded(page, "/", "/api/skills/featured");
      await expect(page.getByRole("heading", { name: "Featured skills" })).toBeVisible();
      const featuredSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Featured skills" }) });
      await expect(featuredSection.locator('a[href="/skills/global/pdf-tools"]')).toBeVisible();

      // Placement (SKILLY_SPEC.md §7): Featured sits immediately below the stats row and above the
      // "Installing is one command." explainer.
      const statsBox = await page.locator("section.stat-row").boundingBox();
      const featuredBox = await page.getByRole("heading", { name: "Featured skills" }).boundingBox();
      const installBox = await page.getByRole("heading", { name: "Installing is one command." }).boundingBox();
      expect(statsBox!.y).toBeLessThan(featuredBox!.y);
      expect(featuredBox!.y).toBeLessThan(installBox!.y);

      // Un-spotlight through the UI → the pin is removed again.
      await gotoLoaded(page, SKILL, DETAIL);
      await expect(spotlighted).toBeVisible();
      refreshed = awaitApi(page, DETAIL);
      await clickAndAwait(page, () => spotlighted.click(), "/feature", { method: "POST" });
      await refreshed;
      await expect(spotlight).toBeVisible();
    } finally {
      await setFeatured(page, false); // never leave the seed spotlighted, whatever failed above
    }
  });
});
