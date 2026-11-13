// e2e: the community leaderboard (SKILLY_SPEC.md §21), capped at the fixed top-100 display limit.
// The page opens on the "Installed" sort (a person's own installs): it is the first "Rank by"
// button, selected by default, and captions the big number "installed". "Installs received" is
// second; choosing it fetches its own board and captions the number "installs". The §21 "Row
// layout" checks run on the default view: no Collections button, equal row heights, a name column
// of one width on every row, and at most 4 badges under an avatar. Read-only.
import { test, expect, devSignIn } from "./fixtures";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";

const LEADERBOARD_INITIAL = "/api/leaderboard?window=all&sort=installed";
const LEADERBOARD_RECEIVED = "/api/leaderboard?window=all&sort=installs";

test.describe("leaderboard (§21)", () => {
  test("opens on Installed, renders ranked rows (or the empty state) within the top-100 cap", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/leaderboard", LEADERBOARD_INITIAL);

    await expect(page.getByRole("heading", { name: "Leaderboard." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Ranked by skills installed: the skills each person has installed themselves.")).toBeVisible();

    // The ranking controls are always present regardless of data. "Installed" leads the toggle and
    // is selected by default; "Installs received" follows it; the old bare "Installs" label is gone.
    const rankBy = page.getByRole("group", { name: "Rank by" });
    await expect(rankBy.getByRole("button")).toHaveText([
      "Installed", "Installs received", "Skills adopted", "Requests fulfilled", "Watched", "Requested", "Followed", "Curated",
    ]);
    await expect(rankBy.getByRole("button", { name: "Installed", exact: true })).toHaveClass(/sort-on/);
    await expect(rankBy.getByRole("button", { name: "Installs received", exact: true })).not.toHaveClass(/sort-on/);
    await expect(rankBy.getByRole("button", { name: "Installs", exact: true })).toHaveCount(0);

    // The API contract, read through requests of our own rather than the page's response body: the
    // Installed board is ranked by skillsInstalled, and the API's own fallback is still `installs`.
    const api = await page.request.get(LEADERBOARD_INITIAL);
    expect(api.status(), await api.text()).toBe(200);
    const body = (await api.json()) as { sort: string; entries: { skillsInstalled: number }[] };
    expect(body.sort).toBe("installed");
    for (const e of body.entries) expect(typeof e.skillsInstalled).toBe("number");
    const counts = body.entries.map((e) => e.skillsInstalled);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const fallback = await page.request.get("/api/leaderboard");
    expect(((await fallback.json()) as { sort: string }).sort).toBe("installs");

    // Either seeded contributor rows or a clean empty state — the data region rendered without error.
    await expect(
      page.locator(".lb-row").first().or(page.getByText(/No contributors yet/i)),
    ).toBeVisible();
    const rows = page.locator(".lb-people .lb-row");
    if ((await rows.count()) > 0) {
      // The default view captions the big number "installed".
      await expect(rows.first().locator(".lb-num > div").last()).toHaveText("installed");
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
      // A row whose person has installed something leads its stat line with that number.
      if (counts[0]! > 0) await expect(rows.first().locator(".lb-stats")).toHaveText(/^\d+ skills? installed · \d+ skills? adopted/);
    }

    // The fixed top-100 display cap is never exceeded.
    expect(await page.locator(".lb-row").count()).toBeLessThanOrEqual(100);

    // "Installs received" loads its own board; rows caption the number with the short "installs".
    await clickAndAwait(page, () => rankBy.getByRole("button", { name: "Installs received", exact: true }).click(), LEADERBOARD_RECEIVED);
    await expect(rankBy.getByRole("button", { name: "Installs received", exact: true })).toHaveClass(/sort-on/);
    await expect(rankBy.getByRole("button", { name: "Installed", exact: true })).not.toHaveClass(/sort-on/);
    await expect(
      page.locator(".lb-row").first().or(page.getByText(/No contributors yet/i)),
    ).toBeVisible();
    if ((await rows.count()) > 0) {
      await expect(rows.first().locator(".lb-num > div").last()).toHaveText("installs");
      expect(await rows.count()).toBeLessThanOrEqual(100);
    }
  });
});
