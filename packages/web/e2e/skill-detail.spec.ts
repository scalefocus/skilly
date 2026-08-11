// e2e: the skill detail page surfaces (SKILLY_SPEC.md §7, §9, §11). Against the seeded, org-visible
// `global/pdf-tools` skill: its versions render, the rating control round-trips (rate → clear), and
// the watch toggle round-trips (watch → unwatch). The maintainers panel is present for the admin.
// Self-cleaning: rating and watch are both returned to their unset state, so the seed is untouched.
// (The discussion thread is covered separately by skill-discussion.spec.ts.)
import { test, expect, devSignIn } from "./fixtures";

const SKILL = "/skills/global/pdf-tools";

test.describe("skill detail surfaces (@global/pdf-tools)", () => {
  test("versions, rating round-trip, watch round-trip, maintainers panel", async ({ page }) => {
    await devSignIn(page);

    // Start from a known rating state (no rating), then load the page.
    await page.request.delete("/api/skills/global/pdf-tools/rating");
    await page.goto(SKILL);
    await expect(page.getByRole("heading", { name: "PDF Tools" }).first()).toBeVisible({ timeout: 20_000 });

    // Versions (seeded 1.0.0 / 1.1.0 / 1.2.0-beta.1) are listed.
    await expect(page.getByText("1.1.0").first()).toBeVisible();
    await expect(page.getByText("1.0.0").first()).toBeVisible();

    // ── Rating: set via the API, reload → the "clear my rating" affordance appears; clicking it
    //    revokes the rating (DELETE) and it disappears again (self-clean). ──
    const rated = await page.request.put("/api/skills/global/pdf-tools/rating", { data: { stars: 5 } });
    expect(rated.ok(), await rated.text()).toBeTruthy();
    await page.reload();
    const clearRating = page.getByRole("button", { name: /clear my rating/i });
    await expect(clearRating).toBeVisible({ timeout: 20_000 });
    await clearRating.click();
    await expect(clearRating).toHaveCount(0);

    // ── Watch toggle: normalize to not-watching, watch, then unwatch (self-clean). ──
    const watch = page.getByRole("button", { name: /watch/i }).first();
    await expect(watch).toBeVisible();
    if (/Watching/.test((await watch.textContent()) ?? "")) {
      await watch.click();
      await expect(watch).not.toContainText("Watching");
    }
    await watch.click();
    await expect(watch).toContainText("Watching");
    await watch.click();
    await expect(watch).not.toContainText("Watching");

    // ── Maintainers panel is available to the admin (add control present; no mutation). ──
    await expect(page.getByPlaceholder(/Add a maintainer/i)).toBeVisible();
  });

  // §10: every version row expands to the auto-computed file changes vs its IMMEDIATE predecessor —
  // the mechanical counterpart to the proposer's "What changed" note. Read-only; nothing is created.
  test("a version row expands to its file changes vs the previous version", async ({ page }) => {
    await devSignIn(page);
    await page.goto(SKILL);
    await expect(page.getByRole("heading", { name: "PDF Tools" }).first()).toBeVisible({ timeout: 20_000 });

    // The seeded skill has 1.0.0 / 1.1.0 / 1.2.0-beta.1 — v1.1.0's baseline is v1.0.0.
    const row = page.locator("#version-1\\.1\\.0");
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /what changed/i }).click();

    // Summary + baseline caption + the per-file list (the dev seed's bundles hold a SKILL.md).
    await expect(row.getByText(/added/).first()).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText(/modified/).first()).toBeVisible();
    await expect(row.getByText("vs v1.0.0")).toBeVisible();
    await expect(row.getByText("SKILL.md").first()).toBeVisible();
  });
});
