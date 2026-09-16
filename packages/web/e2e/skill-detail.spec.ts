// e2e: the skill detail page surfaces (SKILLY_SPEC.md §7, §9, §11). Against the seeded, org-visible
// `global/pdf-tools` skill: its versions render, the rating control round-trips (rate → clear), the
// watch toggle round-trips (watch → unwatch), and the maintainers panel is present for the admin.
// Self-cleaning: rating and watch are both returned to their unset state, so the seed is untouched.
// (The discussion thread is covered separately by skill-discussion.spec.ts.)
//
// Hardening (helpers/ready.ts): one four-part test became four focused ones. Starting state is
// normalized through the API (never inferred from the UI), each toggle click is paired with its
// POST and with the detail refetch `act()` issues afterwards, and every page starts from the
// hydrated shell with the detail JSON in. The watch button is matched by its exact two states.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { awaitApi, clickAndAwait, gotoLoaded } from "./helpers/ready";

const SKILL = "/skills/global/pdf-tools";
const API = "/api/skills/global/pdf-tools";
const DETAIL = /\/api\/skills\/global\/pdf-tools$/;
const watchButton = (page: Page) => page.getByRole("button", { name: /^(☆ Watch|★ Watching)$/ });

/** Click a detail-page action and wait for both its POST and the detail refetch it triggers. */
async function act(page: Page, click: () => Promise<void>, path: string): Promise<void> {
  const refreshed = awaitApi(page, DETAIL);
  await clickAndAwait(page, click, `${API}/${path}`, { method: "POST" });
  await refreshed;
}

// Rating and watch mutate the shared dev user's rows on this skill — never interleave.
test.describe.configure({ mode: "serial" });

test.describe("skill detail surfaces (@global/pdf-tools)", () => {
  test("versions are listed", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, DETAIL);
    await expect(page.getByRole("heading", { name: "PDF Tools" }).first()).toBeVisible();
    // Versions (seeded 1.0.0 / 1.1.0 / 1.2.0-beta.1) are listed.
    await expect(page.getByText("1.1.0").first()).toBeVisible();
    await expect(page.getByText("1.0.0").first()).toBeVisible();
  });

  test("rating round-trip: rated via the API → the clear affordance appears → clearing revokes it", async ({ page }) => {
    await devSignIn(page);
    // Known starting state, then a 5-star rating — both server-side.
    await page.request.delete(`${API}/rating`);
    const rated = await page.request.put(`${API}/rating`, { data: { stars: 5 } });
    expect(rated.ok(), await rated.text()).toBeTruthy();
    try {
      await gotoLoaded(page, SKILL, DETAIL);
      const clearRating = page.getByRole("button", { name: /clear my rating/i });
      await expect(clearRating).toBeVisible();
      await clickAndAwait(page, () => clearRating.click(), `${API}/rating`, { method: "DELETE" });
      await expect(clearRating).toHaveCount(0);
    } finally {
      await page.request.delete(`${API}/rating`); // self-clean whatever happened above
    }
  });

  test("watch round-trip: watch → Watching → unwatch", async ({ page }) => {
    await devSignIn(page);
    const setWatch = (watch: boolean) => page.request.post(`${API}/watch`, { data: { watch } });
    expect((await setWatch(false)).ok()).toBeTruthy(); // normalize server-side, not by reading the UI
    try {
      await gotoLoaded(page, SKILL, DETAIL);
      const watch = watchButton(page);
      await expect(watch).toHaveText("☆ Watch");
      await act(page, () => watch.click(), "watch");
      await expect(watch).toHaveText("★ Watching");
      await act(page, () => watch.click(), "watch");
      await expect(watch).toHaveText("☆ Watch");
    } finally {
      await setWatch(false); // never leave the seed watched
    }
  });

  test("the maintainers panel is available to the admin", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, DETAIL);
    // Add control present; no mutation.
    await expect(page.getByPlaceholder(/Add a maintainer/i)).toBeVisible();
  });

  // §10: every version row expands to the auto-computed file changes vs its IMMEDIATE predecessor —
  // the mechanical counterpart to the proposer's "What changed" note. Read-only; nothing is created.
  test("a version row expands to its file changes vs the previous version", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, DETAIL);
    await expect(page.getByRole("heading", { name: "PDF Tools" }).first()).toBeVisible();

    // The seeded skill has 1.0.0 / 1.1.0 / 1.2.0-beta.1 — v1.1.0's baseline is v1.0.0.
    const row = page.locator("#version-1\\.1\\.0");
    await expect(row).toBeVisible();
    // The diff vs the predecessor is computed server-side on demand - wait for that response.
    await clickAndAwait(page, () => row.getByRole("button", { name: /what changed/i }).click(), /\/versions\/1\.1\.0\/changes/);

    // Summary + baseline caption + the per-file list (the dev seed's bundles hold a SKILL.md).
    await expect(row.getByText(/added/).first()).toBeVisible();
    await expect(row.getByText(/modified/).first()).toBeVisible();
    await expect(row.getByText("vs v1.0.0")).toBeVisible();
    await expect(row.getByText("SKILL.md").first()).toBeVisible();
  });
});
