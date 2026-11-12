// e2e: the Overview's stat row and "Recently published" grid (SKILLY_SPEC.md §10).
//
// The three skill tiles — "Skills visible to you", "Hosted", "External" — are TRUE totals read from
// GET /api/stats, never the number of rows a listing returned: through v2.57.0 they counted the
// rows of GET /api/skills, a capped listing, which froze the first tile at 60. "Recently
// published" shows the first 6 rows of the catalog's Latest sort, in that order.
//
// Read-only (PARALLEL in groups.ts). Other specs publish skills while this one runs, so every
// assertion compares the page with the very responses the page itself received — never with a
// second request, which could legitimately return a newer catalog.
import { test, expect, devSignIn } from "./fixtures";
import { awaitApi, gotoReady } from "./helpers/ready";

/** components/ui.tsx `formatCount`: verbatim under 1000, compact above. */
const formatCount = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

const STATS = /\/api\/stats$/;
const RECENT = "/api/skills?sort=latest&limit=6";

interface Stats {
  totalInstalls: number;
  skills: { total: number; hosted: number; pointer: number };
}
interface Listing {
  skills: { namespaceSlug: string; skillSlug: string; updatedAt: string; deprecation: unknown }[];
}

test.describe("overview stat row and Recently published", () => {
  test("the skill tiles show the viewer's totals from /api/stats, not a listing's row count", async ({ page }) => {
    await devSignIn(page);
    const statsRes = awaitApi(page, STATS);
    const recentRes = awaitApi(page, RECENT);
    await gotoReady(page, "/");
    const stats = (await (await statsRes).json()) as Stats;
    const recent = (await (await recentRes).json()) as Listing;

    // The contract (§15): the caller's visible skills in total and by type, the total their sum.
    expect(stats.skills.total).toBe(stats.skills.hosted + stats.skills.pointer);
    expect(stats.skills.total).toBeGreaterThan(0); // the seeded catalog is never empty

    await expect(page.getByTestId("stat-skills-total")).toHaveText(formatCount(stats.skills.total));
    await expect(page.getByTestId("stat-skills-hosted")).toHaveText(formatCount(stats.skills.hosted));
    await expect(page.getByTestId("stat-skills-pointer")).toHaveText(formatCount(stats.skills.pointer));

    // The listing the page loads is the 6-row "Recently published" feed — it can no longer be
    // what the tiles count, and it is never more than 6 rows.
    expect(recent.skills.length).toBeLessThanOrEqual(6);
    expect(recent.skills.length).toBeLessThanOrEqual(stats.skills.total);
  });

  test("Recently published lists the Latest sort's first rows, newest version first", async ({ page }) => {
    await devSignIn(page);
    const recentRes = awaitApi(page, RECENT);
    await gotoReady(page, "/");
    const recent = (await (await recentRes).json()) as Listing;
    expect(recent.skills.length).toBeGreaterThan(0);

    // The response is in Latest order (§10): deprecated skills last, and within each part the
    // most recently published version first.
    const firstDeprecated = recent.skills.findIndex((s) => s.deprecation != null);
    const live = firstDeprecated === -1 ? recent.skills : recent.skills.slice(0, firstDeprecated);
    const tail = firstDeprecated === -1 ? [] : recent.skills.slice(firstDeprecated);
    expect(tail.every((s) => s.deprecation != null), "deprecated skills sort last").toBeTruthy();
    for (const part of [live, tail]) {
      const stamps = part.map((s) => Date.parse(s.updatedAt));
      expect(stamps, "newest version first").toEqual([...stamps].sort((a, b) => b - a));
    }

    // The grid renders exactly those rows, in that order.
    const cards = page.getByTestId("recently-published-section").locator("a.skill-card");
    await expect(cards).toHaveCount(recent.skills.length);
    const hrefs = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    expect(hrefs).toEqual(recent.skills.map((s) => `/skills/${s.namespaceSlug}/${s.skillSlug}`));
  });
});
