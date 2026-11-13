// e2e: the community leaderboard (SKILLY_SPEC.md §21). Ranks contributors by the installs their
// skills receive, capped at the fixed top-100 display limit. We assert the page renders, its
// "Rank by" controls are present under their current names ("Installs received", and the "Installed"
// sort for a person's own installs), the Installed sort fetches its own board and captions the big
// number "installed", and the display never exceeds the top-100 cap. The §21 "Row layout" checks:
// the "installs" caption, no Collections button, equal row heights, a name column of one width on
// every row, and at most 4 badges under an avatar. Read-only.
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
    const rows = page.locator(".lb-people .lb-row");
    if ((await rows.count()) > 0) {
      // §21 "Row layout": the caption is the short word, the button keeps "Installs received".
      await expect(rows.first().locator(".lb-num > div").last()).toHaveText("installs");
      // Four actions at most: the Collections button is gone from every row.
      await expect(rows.getByRole("link", { name: "Collections", exact: true })).toHaveCount(0);
      // Every row is the same height, and the name column is the same width on every row.
      const boxes = await rows.evaluateAll((els) =>
        els.slice(0, 20).map((el) => ({
          height: el.getBoundingClientRect().height,
          name: el.querySelector(".lb-who")!.getBoundingClientRect().width,
        })),
      );
      for (const b of boxes) {
        expect(Math.abs(b.height - boxes[0]!.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(b.name - boxes[0]!.name)).toBeLessThanOrEqual(1);
      }
      // The default 1280 px viewport leaves the name column well over 250 px on the 980 px board.
      expect(boxes[0]!.name).toBeGreaterThan(250);
      // A capped badge line never wraps: at most 4 badges and a +N marker under any avatar.
      const perRow = await rows.evaluateAll((els) => els.map((el) => el.querySelectorAll('.lb-av [aria-label$="all time"], .lb-av [aria-label$="last 30 days"]').length));
      for (const n of perRow) expect(n).toBeLessThanOrEqual(4);
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
      await expect(rows.first().locator(".lb-num > div").last()).toHaveText("installed");
      expect(await rows.count()).toBeLessThanOrEqual(100);
    }
  });
});
