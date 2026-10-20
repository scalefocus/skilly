// e2e: Hype (SKILLY_SPEC.md §50). Runs against the dev stack (SKILLY_DEV_AUTH=1, a platform-admin
// dev user who is NOT a maintainer of the seeded `global/*` skills). The seeded skills have more
// installs than the default threshold, so the test widens the two eligibility thresholds through
// the admin settings API first and restores the defaults in `finally`.
//
//   detail page: Hype → "✓ Hyped" (disabled) and the "Hyped by" card lists the dev user;
//   leaderboard: the Hyped skills tab lists the skill with its points, the strip and the disabled
//     "✓ Hyped" button, and the budget line counts the spent hype;
//   admin: the Hype card saves the top N and its header summary follows.
//
// Hypes have no undo by design (§50.1), so a re-run on the same database within 7 days starts from
// "already hyped": the test normalizes by accepting either starting state and asserting the end
// state, which is the same in both. A fresh CI stack always takes the click path.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { awaitApi, clickAndAwait, gotoLoaded } from "./helpers/ready";

const SKILL = "/skills/global/web-scraper";
const DETAIL = /\/api\/skills\/global\/web-scraper$/;
const DEFAULTS = { hypeEnabled: true, hypeBudget: 3, hypeRecencyDays: 90, hypeInstallThreshold: 25, hypeTopN: 5 };
const settings = (page: Page, data: Record<string, unknown>) => page.request.patch("/api/admin/settings", { data });

// Mutates platform-wide hype settings — never interleave with another hype test.
test.describe.configure({ mode: "serial" });

test.describe("hype (@global/web-scraper)", () => {
  test("hype a skill → ✓ Hyped and Hyped by → the Hyped skills board → admin card", async ({ page }) => {
    await devSignIn(page);
    expect((await settings(page, { ...DEFAULTS, hypeRecencyDays: 365, hypeInstallThreshold: 10_000 })).ok()).toBeTruthy();

    try {
      await gotoLoaded(page, SKILL, DETAIL);
      const button = page.getByTestId("hype-button");
      await expect(button).toBeVisible();

      // Click path (fresh stack): POST /hype, then the detail refetch flips the button.
      if (!(await button.textContent())?.includes("✓ Hyped")) {
        await expect(button).toBeEnabled();
        const refreshed = awaitApi(page, DETAIL);
        await clickAndAwait(page, () => button.click(), "/api/skills/global/web-scraper/hype", { method: "POST" });
        await refreshed;
      }
      await expect(button).toContainText("✓ Hyped");
      await expect(button).toBeDisabled();
      const hypedBy = page.getByTestId("hyped-by");
      await expect(hypedBy).toBeVisible();
      await expect(hypedBy.getByTestId("hyper-strip")).toBeVisible();

      // The Hyped skills tab: the row, its points, the disabled button and the budget line.
      await gotoLoaded(page, "/leaderboard?tab=hyped", "/api/leaderboard/hyped");
      await expect(page.getByRole("tab", { name: "Hyped skills" })).toHaveAttribute("aria-selected", "true");
      const row = page.getByTestId("hyped-row").filter({ has: page.locator('a[href="/skills/global/web-scraper"]') });
      await expect(row).toBeVisible();
      await expect(row.getByText("points")).toBeVisible();
      await expect(row.getByTestId("hype-button")).toBeDisabled();
      await expect(page.getByTestId("hype-budget")).toContainText(/You have [0-2] of 3 hypes left/);

      // Switching tabs keeps the People board as it was.
      await page.getByRole("tab", { name: "People" }).click();
      await expect(page.getByRole("group", { name: "Rank by" })).toBeVisible();

      // Admin: the Hype card saves the top N and its header summary follows; back to 5.
      await gotoLoaded(page, "/admin", "/api/admin/settings");
      const header = page.getByRole("button", { name: /^Hype\b/ });
      await header.click();
      const topN = page.getByLabel("Top N");
      await expect(topN).toBeVisible();
      await topN.fill("4");
      await clickAndAwait(page, () => topN.press("Enter"), "/api/admin/settings", { method: "PATCH" });
      await expect(header).toContainText("top 4");
    } finally {
      await settings(page, DEFAULTS);
    }
  });

  // §31.12: the hype above earned Hype Squad; with hype switched off, the hype badges the dev user
  // lacks show the "not available here" tile on the profile card, and the level still counts all 31.
  test("achievements: Hype Squad is earned; switched-off hype badges say so on the profile card", async ({ page }) => {
    await devSignIn(page);
    const me = await (await page.request.get("/api/me")).json();
    const view = async () => (await page.request.get(`/api/users/${me.userId}/achievements`)).json();
    const held = (v: { earned: { key: string }[] }) => new Set(v.earned.map((e) => e.key));
    expect(held(await view()).has("first_hype"), "the hype in the previous test earned Hype Squad").toBe(true);

    expect((await settings(page, { ...DEFAULTS, hypeEnabled: false })).ok()).toBeTruthy();
    try {
      const off = await view();
      const earned = held(off);
      for (const k of ["hype_train", "first_hype", "talent_scout"]) {
        expect(off.unavailable.includes(k), k).toBe(!earned.has(k));
      }

      await gotoLoaded(page, "/profile", /\/api\/users\/[^/]+\/achievements$/);
      const card = page.getByTestId("achievements-card");
      await expect(card).toBeVisible();
      await expect(page.getByTestId("level-bar")).toContainText(/ of 31/);
      await expect(card.locator('[data-badge="first_hype"]')).toHaveAttribute("data-earned", "1");
      await expect(card.locator("[data-unavailable]")).toHaveCount(off.unavailable.length);
      for (const k of off.unavailable as string[]) {
        const tile = card.locator(`[data-badge="${k}"]`);
        await expect(tile).toHaveAttribute("data-unavailable", "1");
        await expect(tile).toContainText("Not available here yet");
      }
    } finally {
      await settings(page, DEFAULTS);
    }
  });
});
