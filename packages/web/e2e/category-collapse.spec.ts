// e2e: the Category facet row collapses, and starts collapsed (§10/§26). Runs against the dev
// stack (SKILLY_DEV_AUTH=1); opt-in, not part of the default `pnpm -r test`.
//
// The rules worth an e2e (they span localStorage + mount ordering, which unit tests can't reach):
//   * collapsed on a first visit, and the collapsed chips are UNREACHABLE — the block is inert,
//     zero-height, and its buttons cannot take focus. They stay mounted so the row can animate
//     (§10), so "not in the DOM" is no longer the assertion; "cannot be reached" is;
//   * the user's own toggle survives a reload;
//   * an active category filter FORCE-OPENS the row on arrival — a filtered catalog must never be
//     presented with nothing on screen explaining the result count;
//   * that auto-expand does NOT rewrite the stored preference (the invariant most likely to rot);
//   * clearing the filter does not snap the row shut mid-visit.
import { test, expect, devSignIn, type Page } from "./fixtures";

const CATALOG_PREFS = "skilly.catalogPrefs";
const REQUESTS_PREFS = "skilly.requestsPrefs";

const toggle = (page: Page) => page.locator("button.facet-row-toggle").filter({ hasText: "Category" });
const chipbox = (page: Page, id: string) => page.locator(`#facet-row-${id}`);
const chips = (page: Page, id: string) => page.locator(`#facet-row-${id} .facet`);

/**
 * The collapsed guarantee (§10): the chips are MOUNTED — they have to be, or the row could not
 * animate — but the block is `inert` and clipped to zero height, so no chip is visible, focusable
 * or announced. Ancestor clipping alone is invisible to Playwright's visibility check, hence the
 * explicit height + focus assertions rather than `toBeHidden()`.
 */
/** The three transition durations that must read as one motion: block height, chip fade, chevron. */
function transitionDurations(page: Page, id: string): Promise<{ box: string; inner: string; chevron: string }> {
  return chipbox(page, id).evaluate((el) => ({
    box: getComputedStyle(el).transitionDuration,
    inner: getComputedStyle(el.firstElementChild as Element).transitionDuration,
    chevron: getComputedStyle(
      el.closest(".facet-row")!.querySelector(".facet-row-chevron")!,
    ).transitionDuration,
  }));
}

async function expectChipsUnreachable(page: Page, id: string): Promise<void> {
  const box = chipbox(page, id);
  expect(await box.evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  await expect(box).toHaveAttribute("aria-hidden", "true");
  expect((await box.boundingBox())?.height ?? -1).toBe(0);
  const first = chips(page, id).first();
  await expect(first).toBeAttached(); // mounted, unlike the original DOM-removal mechanism
  await first.evaluate((el) => (el as HTMLElement).focus());
  await expect(first).not.toBeFocused();
}

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

test("catalog: the Category row starts collapsed, and the chips are unreachable", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/catalog");
  await clearPrefs(page, CATALOG_PREFS);
  await page.reload();

  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  // Mounted but inert — collapsed chips must leave the tab order entirely.
  await expectChipsUnreachable(page, "catalog-category");
  // The header carries the size of the whole visible vocabulary (dev seed: documents/devtools/data).
  await expect(toggle(page)).toContainText("3");

  // The other rows are untouched: Harness and Source stay flat and always visible.
  await expect(page.locator("button.facet-row-toggle")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "My Skills" })).toBeVisible();
});

test("catalog: the row animates on a user toggle, and releases its clip once open", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/catalog");
  await clearPrefs(page, CATALOG_PREFS);
  await page.reload();

  const box = chipbox(page, "catalog-category");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  // Transitions are armed one frame after mount — height and fade, 0.2s each, one motion with the
  // chevron (§10). Before that frame the row can paint open without sliding.
  await expect(box).toHaveAttribute("data-anim", "true");
  expect(await transitionDurations(page, "catalog-category")).toEqual({ box: "0.2s", inner: "0.2s", chevron: "0.2s" });

  // Opening clips until the block has settled, then releases so an edge chip's focus ring survives.
  await expect(box).toHaveAttribute("data-settled", "false");
  await toggle(page).click();
  await expect(box).toHaveAttribute("data-settled", "true");
  expect(await box.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
  expect((await box.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  expect(await box.evaluate((el) => (el as HTMLElement).inert)).toBe(false);

  // Collapsing re-clips at once, so the close animation still clips.
  await toggle(page).click();
  await expect(box).toHaveAttribute("data-settled", "false");
  expect(await box.evaluate((el) => getComputedStyle(el).overflowY)).toBe("hidden");
});

test("catalog: prefers-reduced-motion gets an instant toggle, no transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await devSignIn(page);
  await page.goto("/catalog");
  await clearPrefs(page, CATALOG_PREFS);
  await page.reload();

  await expect(chipbox(page, "catalog-category")).toHaveAttribute("data-anim", "true");
  expect(await transitionDurations(page, "catalog-category")).toEqual({ box: "0s", inner: "0s", chevron: "0s" });

  // Still a working toggle — only the motion is gone.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(chips(page, "catalog-category").first()).toBeVisible();
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

    // Collapsed by default, chips unreachable, and the count comes from the server facets.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expectChipsUnreachable(page, "requests-category");

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
