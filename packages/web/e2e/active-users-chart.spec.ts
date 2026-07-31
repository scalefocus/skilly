// e2e: the Administration "Active users" trend chart (SKILLY_SPEC.md §4) — span-adaptive bucketing
// and the sparse-series markers. Regression cover for v1.140.1: with a history confined to a single
// calendar month, the "All" range used to bucket monthly, producing a one-point series that draws as
// a dot with no line ("only a single point is shown for all time").
//
// Deliberately data-independent — the dev stack's daily_active_users table may hold anything from
// zero rows to years of history, so the assertions are the ones that hold either way: the fixed
// ranges are ALWAYS daily, "All" never coarsens past what the span justifies, and any series short
// enough to be invisible as a line renders explicit point markers.
// Runs against the dev stack (SKILLY_DEV_AUTH=1); opt-in, not part of the default `pnpm -r test`.
import { test, expect, devSignIn, type Page } from "./fixtures";

interface Series { range: number | "all"; bucket: "day" | "week" | "month"; points: { date: string; count: number }[] }

/** Expand the "Currently online" card if it isn't already open (the open state persists per
 *  browser via localStorage, so a post-reload click would collapse it instead). */
async function openOnlineCard(page: Page): Promise<void> {
  const head = page.getByRole("button", { name: /^Currently online/ });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(page.getByRole("group", { name: "Chart range" })).toBeVisible();
}

/** Click a range in the chart's toggle and return the series the server answered with. The URL is
 *  matched on the exact `range` param so an in-flight mount fetch (default 30d) is never mistaken
 *  for the response to this click. */
const RANGE_PARAM: Record<string, string> = { "7d": "7", "30d": "30", "90d": "90", All: "all" };

async function pickRange(page: Page, label: string): Promise<Series> {
  const want = `/api/admin/users/active-series?range=${RANGE_PARAM[label]}`;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(want) && r.request().method() === "GET"),
    page.getByRole("group", { name: "Chart range" }).getByRole("button", { name: label, exact: true }).click(),
  ]);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as Series;
}

test.describe("active-users trend chart (§4)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible({ timeout: 20_000 });
    // The chart lives inside the (collapsed-by-default) "Currently online" card.
    await openOnlineCard(page);
  });

  test("7d / 30d / 90d always bucket by day", async ({ page }) => {
    // Holds for ANY history: a trailing window of at most 90 days never exceeds the ~92-day daily
    // threshold, so none of the fixed ranges is ever averaged into weeks or months.
    for (const label of ["7d", "30d", "90d"]) {
      const s = await pickRange(page, label);
      expect(s.bucket, `${label} must be daily`).toBe("day");
    }
  });

  test("All buckets by day until the collected history is long enough to coarsen", async ({ page }) => {
    const s = await pickRange(page, "All");
    expect(["day", "week", "month"]).toContain(s.bucket);
    // The span the points cover decides the bucket — a young history must NOT come back monthly.
    if (s.points.length) {
      const spanDays = Math.round((Date.now() - new Date(`${s.points[0]!.date}T00:00:00Z`).getTime()) / 86_400_000) + 1;
      if (spanDays <= 92) expect(s.bucket, `a ${spanDays}-day history must be daily`).toBe("day");
      else if (spanDays <= 730) expect(s.bucket).toBe("week");
      else expect(s.bucket).toBe("month");
      // The single-point-for-all-time symptom is only legitimate on a table with one day in it.
      if (s.points.length === 1) expect(spanDays).toBeLessThanOrEqual(2);
    }
  });

  test("a short series renders visible point markers, a long one renders a line", async ({ page }) => {
    const s = await pickRange(page, "All");
    if (!s.points.length) {
      await expect(page.getByText(/No history yet/)).toBeVisible();
      return;
    }
    const chart = page.locator(".recharts-wrapper").first();
    await expect(chart).toBeVisible();
    const dots = chart.locator(".recharts-line-dot");
    if (s.points.length < 3) {
      // Below 3 points there is no meaningful line — every point must be drawn as a marker.
      await expect(dots).toHaveCount(s.points.length);
    } else {
      await expect(dots).toHaveCount(0);
      await expect(chart.locator(".recharts-line-curve")).toHaveCount(1);
    }
  });

  test("the chosen range is remembered across a reload", async ({ page }) => {
    await pickRange(page, "90d");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible({ timeout: 20_000 });
    await openOnlineCard(page);
    const toggle = page.getByRole("group", { name: "Chart range" });
    await expect(toggle.getByRole("button", { name: "90d", exact: true })).toHaveClass(/sort-on/);
  });
});
