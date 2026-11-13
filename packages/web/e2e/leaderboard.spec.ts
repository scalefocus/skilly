// e2e: the community leaderboard (SKILLY_SPEC.md §21), capped at the fixed top-100 display limit.
// The page opens on the "Installed" sort (a person's own installs): it is the first "Rank by"
// button, selected by default, and captions the big number "installed". "Installs received" is
// second; choosing it fetches its own board and captions the number "installs". The §21 "Row
// layout" checks run on the default view: no Collections button, equal row heights, a name column
// of one width on every row, at most 4 badges under an avatar, and the four §21 "Action slots" at
// the same place on every row (the Reach out and Follow slots at least as wide as "Reach out" and
// "Unfollow"). Two more tests load the page in a 390 px and a 1024 px window, where the board is
// under 760 px wide, and check the three-band rows of §21 "Narrow screens": the stat line under
// the name, and the four slots a quarter of the row each, at the same place on every row.
// Read-only: no test follows anyone, so an Unfollow row is covered by the slot widths, not seen.
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
    // §21 "Plugin deliveries are not adoption".
    await expect(page.getByText("Skills that arrive through a plugin marketplace are not counted.")).toBeVisible();

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
      // The default 1280 px viewport leaves the board wide enough for the desktop columns.
      await expect(page.locator(".lb-people")).not.toHaveClass(/lb-compact/);
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
      // §21 "Action slots": four slots on every row, each at the same x and width on every row, so
      // a button never shifts with what the row holds (Follow or Unfollow; your own row's two empty
      // slots). The Reach out and Follow slots are at least as wide as a "Reach out" and an
      // "Unfollow" button, so neither a pending "…" nor the Follow ↔ Unfollow flip resizes them.
      const slots = await rows.evaluateAll((els) => {
        const probe = (label: string) => {
          const b = document.createElement("button");
          b.className = "btn btn-sm";
          b.textContent = label;
          Object.assign(b.style, { position: "absolute", visibility: "hidden", left: "0", top: "0" });
          document.body.appendChild(b);
          const w = b.getBoundingClientRect().width;
          b.remove();
          return w;
        };
        const rs = els.slice(0, 20);
        const slotBoxes = (r: Element) => [...r.querySelectorAll(".lb-actions > .lb-slot")].map((s) => s.getBoundingClientRect());
        return {
          lefts: rs.map((r) => slotBoxes(r).map((b) => b.left)),
          widths: rs.map((r) => slotBoxes(r).map((b) => b.width)),
          reachOut: probe("Reach out"),
          unfollow: probe("Unfollow"),
          clipped: rs.flatMap((r) => [...r.querySelectorAll(".lb-actions .btn")]).filter((b) => b.scrollWidth > b.clientWidth).length,
        };
      });
      for (const row of slots.lefts) expect(row).toHaveLength(4);
      for (const row of slots.lefts) row.forEach((x, i) => expect(Math.abs(x - slots.lefts[0]![i]!)).toBeLessThanOrEqual(1));
      for (const row of slots.widths) row.forEach((w, i) => expect(Math.abs(w - slots.widths[0]![i]!)).toBeLessThanOrEqual(1));
      expect(slots.widths[0]![2]!).toBeGreaterThanOrEqual(slots.reachOut - 0.5);
      expect(slots.widths[0]![3]!).toBeGreaterThanOrEqual(slots.unfollow - 0.5);
      expect(slots.clipped).toBe(0);
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

  // §21 "Narrow screens": whenever the BOARD is narrower than 760 px — a phone, or a 1024 px window
  // whose sidebar leaves the board 682 px — a row is three bands (rank · avatar · name · number /
  // the stat line under the name on two reserved rows / the four action slots on one line) and
  // every row is the same height.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    test(`a narrow board (${viewport.width} px window) uses three-band rows of equal height`, async ({ page }) => {
      await devSignIn(page);
      await page.setViewportSize(viewport);
      await gotoLoaded(page, "/leaderboard", LEADERBOARD_INITIAL);
      await expect(
        page.locator(".lb-row").first().or(page.getByText(/No contributors yet/i)),
      ).toBeVisible();
      const board = page.locator(".lb-people");
      if ((await board.count()) === 0) return; // empty state: nothing to lay out

      await expect(board).toHaveClass(/lb-compact/);
      const m = await board.evaluate((el) => {
        const rows = [...el.querySelectorAll(".lb-row")].slice(0, 20);
        const box = (x: Element | null) => x!.getBoundingClientRect();
        const buttons = rows.flatMap((r) => [...r.querySelectorAll(".lb-actions .btn")]);
        return {
          board: box(el).width,
          rowHeights: rows.map((r) => box(r).height),
          statsHeights: rows.map((r) => box(r.querySelector(".lb-stats")).height),
          nameWidths: rows.map((r) => box(r.querySelector(".lb-name")).width),
          // Band order, top to bottom: the name, then the stat line, then the actions.
          bandsInOrder: rows.every((r) => box(r.querySelector(".lb-name")).bottom <= box(r.querySelector(".lb-stats")).top + 1
            && box(r.querySelector(".lb-stats")).bottom <= box(r.querySelector(".lb-actions")).top + 1),
          // Band 2 sits under the name: from the name's left edge to the row's right content edge.
          statsUnderName: rows.every((r) => {
            const stats = box(r.querySelector(".lb-stats"));
            const contentRight = box(r).right - parseFloat(getComputedStyle(r).paddingRight);
            return Math.abs(stats.left - box(r.querySelector(".lb-name")).left) <= 1 && Math.abs(stats.right - contentRight) <= 1;
          }),
          slotLefts: rows.map((r) => [...r.querySelectorAll(".lb-actions > .lb-slot")].map((s) => box(s).left)),
          slotWidths: rows.map((r) => [...r.querySelectorAll(".lb-actions > .lb-slot")].map((s) => box(s).width)),
          buttonHeights: buttons.map((b) => box(b).height),
          clippedLabels: buttons.filter((b) => b.scrollWidth > b.clientWidth).length,
          buttonWhiteSpace: [...new Set(buttons.map((b) => getComputedStyle(b).whiteSpace))],
          buttonFonts: [...new Set(buttons.map((b) => getComputedStyle(b).fontSize))],
          badgesPerRow: rows.map((r) => r.querySelectorAll('.lb-av [aria-label$="all time"], .lb-av [aria-label$="last 30 days"]').length),
          pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(m.board).toBeLessThan(760);
      for (const h of m.rowHeights) expect(Math.abs(h - m.rowHeights[0]!)).toBeLessThanOrEqual(1);
      // Two rows reserved for the stats on every row, whatever the line's length.
      for (const h of m.statsHeights) expect(Math.abs(h - m.statsHeights[0]!)).toBeLessThanOrEqual(1);
      expect(m.statsHeights[0]!).toBeGreaterThan(28);
      expect(m.bandsInOrder).toBe(true);
      expect(m.statsUnderName).toBe(true);
      // Band 3: four slots on every row, a quarter of the row each (also on your own row, whose
      // last two are empty), at the same x on every row.
      for (const row of m.slotLefts) expect(row).toHaveLength(4);
      for (const row of m.slotLefts) row.forEach((x, i) => expect(Math.abs(x - m.slotLefts[0]![i]!)).toBeLessThanOrEqual(1));
      for (const row of m.slotWidths) for (const w of row) expect(Math.abs(w - m.slotWidths[0]![0]!)).toBeLessThanOrEqual(1);
      // The name column is one width on every row, and has room for a name (it was ~70 px on a phone).
      for (const w of m.nameWidths) expect(Math.abs(w - m.nameWidths[0]!)).toBeLessThanOrEqual(1);
      expect(m.nameWidths[0]!).toBeGreaterThan(130);
      // Every button label is on one row, in one shared smaller font, and none is clipped.
      for (const h of m.buttonHeights) expect(Math.abs(h - m.buttonHeights[0]!)).toBeLessThanOrEqual(1);
      expect(m.buttonWhiteSpace).toEqual(["nowrap"]);
      expect(m.buttonFonts).toEqual(["12px"]);
      expect(m.clippedLabels).toBe(0);
      // A narrow board shows at most 2 leader badges before the +N marker.
      for (const n of m.badgesPerRow) expect(n).toBeLessThanOrEqual(2);
      expect(m.pageScrollsSideways).toBe(false);
    });
  }
});
