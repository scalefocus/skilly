// e2e: the Category facet row collapses, and starts collapsed (§10/§26). Runs against the dev
// stack (SKILLY_DEV_AUTH=1); opt-in, not part of the default `pnpm -r test`.
//
// The rules worth an e2e (they span localStorage + mount ordering, which unit tests can't reach):
//   * collapsed on a first visit, chips absent from the DOM entirely (not merely hidden);
//   * the user's own toggle survives a reload;
//   * an active category filter FORCE-OPENS the row on arrival — a filtered catalog must never be
//     presented with nothing on screen explaining the result count;
//   * that auto-expand does NOT rewrite the stored preference (the invariant most likely to rot);
//   * clearing the filter does not snap the row shut mid-visit.
import { test, expect, devSignIn, type Page } from "./fixtures";

const CATALOG_PREFS = "skilly.catalogPrefs";
const REQUESTS_PREFS = "skilly.requestsPrefs";

const toggle = (page: Page) => page.locator("button.facet-row-toggle").filter({ hasText: "Category" });
const chips = (page: Page, id: string) => page.locator(`#facet-row-${id} .facet`);

/** The persisted collapse flag — `undefined` when the page has never written its prefs. */
async function storedOpen(page: Page, key: string): Promise<boolean | undefined> {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw).categoryOpen as boolean | undefined) : undefined;
  }, key);
}

async function clearPrefs(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => localStorage.removeItem(k), key);
}

test("catalog: the Category row starts collapsed, and the chips are out of the DOM", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/catalog");
  await clearPrefs(page, CATALOG_PREFS);
  await page.reload();

  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  // Removed, not hidden — collapsed chips must leave the tab order entirely.
  await expect(chips(page, "catalog-category")).toHaveCount(0);
  // The header carries the size of the whole visible vocabulary (dev seed: documents/devtools/data).
  await expect(toggle(page)).toContainText("3");

  // The other rows are untouched: Harness and Source stay flat and always visible.
  await expect(page.locator("button.facet-row-toggle")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "My Skills" })).toBeVisible();
});

test("catalog: expanding reveals the chips and the choice survives a reload", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/catalog");
  await clearPrefs(page, CATALOG_PREFS);
  await page.reload();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(chips(page, "catalog-category").first()).toBeVisible();
  expect(await storedOpen(page, CATALOG_PREFS)).toBe(true);

  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

  // Collapsing again is likewise remembered.
  await toggle(page).click();
  expect(await storedOpen(page, CATALOG_PREFS)).toBe(false);
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("catalog: an active category filter force-opens the row without rewriting the preference", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/catalog");
  await clearPrefs(page, CATALOG_PREFS);
  await page.reload();

  // Pick a category, then collapse the row by hand — the filter stays on.
  await toggle(page).click();
  const chip = chips(page, "catalog-category").first();
  const chipName = ((await chip.textContent()) ?? "").trim();
  await chip.click();
  await expect(page.getByRole("button", { name: "✕ clear filters" })).toBeVisible();
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect(await storedOpen(page, CATALOG_PREFS)).toBe(false);

  // Arriving again with that filter restored: the row opens anyway, so the filtered result count
  // has a visible cause…
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#facet-row-catalog-category .facet-on")).toHaveCount(1);
  // …but the stored preference is still the user's own collapsed choice.
  expect(await storedOpen(page, CATALOG_PREFS)).toBe(false);

  // Clearing the filter does NOT snap the row shut mid-visit.
  await page.getByRole("button", { name: "✕ clear filters" }).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(chips(page, "catalog-category").first()).toBeVisible();
  expect(chipName.length).toBeGreaterThan(0);

  // And with no filter left to force it open, the next visit honours the collapsed preference.
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("requests: the Category row behaves identically, on server-supplied facets", async ({ page }) => {
  await devSignIn(page);
  // Nothing is seeded, so post a request carrying a category of its own.
  const token = `cc${Date.now()}`;
  const res = await page.request.post("/api/requests", {
    multipart: {
      title: `${token} collapse fixture`,
      description: "Auto-created by category-collapse.spec",
      toolHarness: "generic",
      categories: JSON.stringify([token]),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()) as { id: string };

  try {
    await page.goto("/requests");
    await clearPrefs(page, REQUESTS_PREFS);
    await page.reload();

    // Collapsed by default, chips absent, and the count comes from the server facets.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(chips(page, "requests-category")).toHaveCount(0);

    // Expanding shows the chip, and the vocabulary does not shrink when the filter is applied —
    // the whole point of moving the facets server-side.
    await toggle(page).click();
    const countBefore = await chips(page, "requests-category").count();
    expect(countBefore).toBeGreaterThan(0);
    await chips(page, "requests-category").filter({ hasText: token }).click();
    await expect(page.locator("#facet-row-requests-category .facet-on")).toHaveCount(1);
    await expect(chips(page, "requests-category")).toHaveCount(countBefore);

    // The choice persists, in the page's own new prefs object.
    expect(await storedOpen(page, REQUESTS_PREFS)).toBe(true);
  } finally {
    await page.request.delete(`/api/requests/${created.id}`);
  }
});
