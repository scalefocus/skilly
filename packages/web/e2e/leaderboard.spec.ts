// e2e: the community leaderboard (SKILLY_SPEC.md §21). Ranks contributors by the installs their
// skills receive, capped at the fixed top-100 display limit. We assert the page renders, its
// "Rank by" controls are present under their current names ("Installs received", and the "Installed"
// sort for a person's own installs), the Installed sort fetches its own board and captions the big
// number "installed", and the display never exceeds the top-100 cap. Read-only.
import { test, expect, devSignIn } from "./fixtures";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";

const LEADERBOARD_INITIAL = "/api/leaderboard?window=all&sort=installs";
const LEADERBOARD_INSTALLED = "/api/leaderboard?window=all&sort=installed";

test.describe("leaderboard (§21)", () => {
  test("renders ranked contributors (or the empty state) within the top-100 cap", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/leaderboard", LEADERBOARD_INITIAL);

    await expect(page.getByRole("heading", { name: "Leaderboard." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Your own installs count under Skills installed.")).toBeVisible();

    // The ranking controls are always present regardless of data. "Installs received" is the
    // default sort; the old bare "Installs" label is gone.
    const rankBy = page.getByRole("group", { name: "Rank by" });
    await expect(rankBy.getByRole("button", { name: "Installs received", exact: true })).toHaveClass(/sort-on/);
    await expect(rankBy.getByRole("button", { name: "Installs", exact: true })).toHaveCount(0);
    await expect(rankBy.getByRole("button", { name: "Skills adopted", exact: true })).toBeVisible();
    await expect(rankBy.getByRole("button", { name: "Requests fulfilled", exact: true })).toBeVisible();
    await expect(rankBy.getByRole("button", { name: "Watched", exact: true })).toBeVisible();
    await expect(rankBy.getByRole("button", { name: "Requested", exact: true })).toBeVisible();
    await expect(rankBy.getByRole("button", { name: "Installed", exact: true })).toBeVisible();

    // Either seeded contributor rows or a clean empty state — the data region rendered without error.
    await expect(
      page.locator(".lb-row").first().or(page.getByText(/No contributors yet/i)),
    ).toBeVisible();
    if ((await page.locator(".lb-row").count()) > 0) {
      await expect(page.locator(".lb-row").first()).toContainText(/installs received/i);
    }

    // The fixed top-100 display cap is never exceeded.
    expect(await page.locator(".lb-row").count()).toBeLessThanOrEqual(100);

    // The Installed sort (a person's own installs) loads its own board; rows caption the number "installed".
    await clickAndAwait(page, () => rankBy.getByRole("button", { name: "Installed", exact: true }).click(), LEADERBOARD_INSTALLED);
    await expect(rankBy.getByRole("button", { name: "Installed", exact: true })).toHaveClass(/sort-on/);
    // The API contract, read through a request of our own rather than the page's response body.
    const api = await page.request.get(LEADERBOARD_INSTALLED);
    expect(api.status(), await api.text()).toBe(200);
    const body = (await api.json()) as { sort: string; entries: { skillsInstalled: number }[] };
    expect(body.sort).toBe("installed");
    for (const e of body.entries) expect(typeof e.skillsInstalled).toBe("number");
    const counts = body.entries.map((e) => e.skillsInstalled);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    await expect(
      page.locator(".lb-row").first().or(page.getByText(/No contributors yet/i)),
    ).toBeVisible();
    if (body.entries.length > 0) {
      await expect(page.locator(".lb-row").first()).toContainText(/installed/i);
      expect(await page.locator(".lb-row").count()).toBeLessThanOrEqual(100);
    }
  });
});
