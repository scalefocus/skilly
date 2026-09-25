// e2e: real user monitoring (SKILLY_SPEC.md §32) — the browser collector beacons page views for the
// pages the dev admin visits, the /admin/rum page lists those routes (plus the pinned "All routes"
// row) and drills down to the acting user, the beacon's trust boundary answers 401 signed-out and
// 400 to a malformed batch, and flipping the header switch off shows the banner and stops the
// beacon. Runs against the dev stack (SKILLY_DEV_AUTH=1) — serial, because it flips a platform
// setting the shared dev user sees. The 90d/All ranges read `rum_daily`, which only the worker's
// hourly sweep writes and the e2e stack runs no worker, so that test seeds one rollup row itself
// (needs DATABASE_URL in the launching shell, like whats-new-notice.spec.ts).
import { Pool } from "pg";
import { test, expect, devSignIn, type Page } from "./fixtures";

test.describe.configure({ mode: "serial" });

const SID = "e2e-rum-session-0001";
/** The (day, route) row seeded into `rum_daily` for the rollup-range test; removed afterwards. */
const ROLLUP_ROUTE = "/e2e/rum-rollup";
const dbUrl = process.env.DATABASE_URL;

/** Wait for the collector's next timed flush to land (10 s cadence, a plain keepalive fetch that
 *  Playwright observes — unlike the sendBeacon path used on hide, which it may not).
 *  The body is read only on a non-204: a 204 has none, and Chromium discards the body entry of a
 *  keepalive fetch anyway, so an eager `res.text()` throws "No data found for resource" and fails
 *  the test before the status is ever compared. */
async function flushRum(page: Page): Promise<void> {
  const res = await page.waitForResponse((r) => r.url().includes("/api/rum") && r.request().method() === "POST", { timeout: 25_000 });
  if (res.status() === 204) return;
  const body = await res.text().catch(() => "<body unavailable>");
  expect(res.status(), body).toBe(204);
}

/** The flush ladder pinned for the run (§32.4/§32.10): a 5 s floor keeps the timed-flush waits short. */
const E2E_FLUSH_INTERVALS = [5, 7];
const DEFAULT_FLUSH_INTERVALS = [17, 23, 37, 59, 97, 157, 251];

test.describe("real user monitoring (§32)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    // Make sure collection is on (a previous aborted run may have left it off) and the ladder is the
    // short e2e set — the collector reads it from /api/me on every page load.
    await page.request.patch("/api/admin/settings", { data: { rumEnabled: true, rumSampleRate: 100, rumFlushIntervals: E2E_FLUSH_INTERVALS } });
  });

  test.afterAll(async ({ browser }) => {
    // Restore the default ladder so a dev stack left running after the suite beacons at 17 s again.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await devSignIn(page);
      await page.request.patch("/api/admin/settings", { data: { rumFlushIntervals: DEFAULT_FLUSH_INTERVALS } });
    } finally {
      await ctx.close();
    }
  });

  test("the beacon rejects signed-out and malformed batches, accepts a valid one", async ({ page, browser }) => {
    // Signed-out: a fresh context has no session cookie → 401.
    const anon = await browser.newContext();
    const res401 = await anon.request.post("/api/rum", { data: { samples: [{ kind: "page_view", route: "/catalog", sessionId: SID }] } });
    expect(res401.status()).toBe(401);
    await anon.close();

    // Malformed: a concrete path instead of a template → 400, whole batch rejected.
    const res400 = await page.request.post("/api/rum", {
      data: { samples: [{ kind: "page_view", route: "/catalog", sessionId: SID }, { kind: "page_view", route: "/skills/global/foo", sessionId: SID }] },
    });
    expect(res400.status()).toBe(400);

    // Valid → 204.
    const res204 = await page.request.post("/api/rum", {
      data: { samples: [{ kind: "page_view", route: "/leaderboard", sessionId: SID }, { kind: "vital", route: "/leaderboard", name: "lcp", value: 1500, sessionId: SID }] },
    });
    expect(res204.status()).toBe(204);
  });

  test("browsing beacons page views and the admin page lists the routes", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await page.goto("/leaderboard");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await flushRum(page);

    await page.goto("/admin/rum");
    await expect(page.getByRole("heading", { name: "Real user monitoring." })).toBeVisible({ timeout: 20_000 });
    // 7d is the default range; the table pins "All routes" first.
    const table = page.getByTestId("rum-routes");
    await expect(table).toBeVisible();
    const rows = table.locator("tbody tr.rum-row");
    await expect(rows.first()).toContainText("All routes");
    await expect(table.locator("tr[data-route='/catalog']")).toBeVisible();
    await expect(table.locator("tr[data-route='/leaderboard']")).toBeVisible();

    // Expanding a route lists who was affected — the dev admin is in there.
    await table.locator("tr[data-route='/leaderboard']").click();
    const users = page.getByTestId("rum-users");
    await expect(users).toBeVisible({ timeout: 10_000 });
    await expect(users).toContainText("Dev Admin");
  });

  test("90d / All read the daily rollup, and their expander has no user dimension", async ({ page }) => {
    test.skip(!dbUrl, "DATABASE_URL not set — cannot seed the rollup");
    // Seed today's rollup row for a sentinel route the way the worker's sweep would; without it the
    // All range has no routes and the page shows its empty state instead of the table.
    const pool = new Pool({ connectionString: dbUrl });
    try {
      await pool.query(
        `insert into rum_daily (day, route, views, sessions, lcp_p75) values (current_date, $1, 3, 1, 1200)
         on conflict (day, route) do update set views = excluded.views, sessions = excluded.sessions, lcp_p75 = excluded.lcp_p75`,
        [ROLLUP_ROUTE],
      );

      await page.goto("/admin/rum");
      await expect(page.getByRole("heading", { name: "Real user monitoring." })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "All", exact: true }).click();
      const table = page.getByTestId("rum-routes");
      await expect(table).toBeVisible({ timeout: 10_000 });
      const row = table.locator(`tr[data-route='${ROLLUP_ROUTE}']`);
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByText("Switch to 7d or 30d to see who was affected.")).toBeVisible();
    } finally {
      await pool.query(`delete from rum_daily where route = $1`, [ROLLUP_ROUTE]).catch(() => {});
      await pool.end();
    }
  });

  test("the sidebar links the page for the admin and the presence label resolves", async ({ page }) => {
    await page.goto("/");
    // Sidebar-only rename (v2.7.0, §32.7): the link reads "Monitoring"; the page title is unchanged.
    const link = page.getByRole("link", { name: "Monitoring", exact: true });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveAttribute("href", "/admin/rum");
    await expect(page.getByRole("link", { name: "Real user monitoring" })).toHaveCount(0);
  });

  test("the Currently online card is the first section, collapsed by default, and expands in place (§4)", async ({ page }) => {
    await page.goto("/admin/rum");
    await expect(page.getByRole("heading", { name: "Real user monitoring." })).toBeVisible({ timeout: 20_000 });
    const head = page.getByRole("button", { name: /^Currently online/ });
    await expect(head).toBeVisible({ timeout: 20_000 });
    // First section: the presence card precedes the telemetry settings switch in DOM order.
    const order = await page.evaluate(() => {
      const card = document.querySelector('[data-last-card="online"]');
      // The only switch on the page is "Collect telemetry" in the telemetry settings card.
      const sw = document.querySelector('[role="switch"]');
      return card && sw ? (card.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : null;
    });
    expect(order, "the online card must come before the telemetry switch").toBe(true);
    // Collapsed by default (fresh browser context) — nothing in the body is reachable yet.
    if ((await head.getAttribute("aria-expanded")) === "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("group", { name: "Chart range" })).toBeHidden();
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("group", { name: "Chart range" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Online window" })).toBeVisible();
    await expect(page.getByLabel("Search online users")).toBeVisible();
    // The live user count in the header comes from /api/admin/users/online, which still polls here.
    await expect(head).toHaveText(/\d+ users?/);
    // The open choice persists across a reload under the same key the Administration card used.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Real user monitoring." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Currently online/ })).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
  });

  test("the flush ladder backs off while idle and snaps back to the floor on a click (§32.4)", async ({ page }) => {
    test.slow(); // wall-clock waiting by design; extra so a slow runner still clears both polls below
    const posts: number[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/rum") && r.method() === "POST") posts.push(Date.now()); });
    await page.goto("/catalog");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });

    // Keep the buffer non-empty WITHOUT user actions: same-origin API calls become `api` samples
    // through the PerformanceObserver, which must not reset the ladder.
    const feeder = setInterval(() => { void page.evaluate(() => fetch("/api/stats").catch(() => {})).catch(() => {}); }, 1000);
    try {
      // Set [5, 7]: ticks at ~5 s (→ step 1), then every 7 s while idle. Wait for three beacons.
      // The poll budget (not the assertions below) is the slack for a slow runner: page-load/
      // hydration and each request round-trip eat into the ~19 s the ladder itself needs before
      // the 3rd beacon lands, and a loaded CI box can burn several extra seconds there without
      // the ladder's own timing being wrong — give it real headroom rather than tightening the
      // window and risking exactly this flake.
      await expect.poll(() => posts.length, { timeout: 55_000, intervals: [500] }).toBeGreaterThanOrEqual(3);
      const idleGap = posts[2]! - posts[1]!;
      expect(idleGap, `idle beacons should be ≥ 7 s apart, got ${idleGap} ms`).toBeGreaterThanOrEqual(6_000);

      // A click is a user action: the next beacon arrives within one floor (5 s) plus slack.
      const n = posts.length;
      const clickedAt = Date.now();
      await page.getByRole("heading").first().click();
      await expect.poll(() => posts.length, { timeout: 18_000, intervals: [250] }).toBeGreaterThan(n);
      const snapGap = posts[n]! - clickedAt;
      expect(snapGap, `after a click the next beacon should land within ~5 s, got ${snapGap} ms`).toBeLessThanOrEqual(8_000);
    } finally {
      clearInterval(feeder);
    }
  });

  test("the header field saves a new ladder and rejects an out-of-bounds one inline (§32.6)", async ({ page }) => {
    await page.goto("/admin/rum");
    await expect(page.getByRole("heading", { name: "Real user monitoring." })).toBeVisible({ timeout: 20_000 });
    const field = page.getByLabel("Flush intervals (comma-separated seconds)");
    await expect(field).toHaveValue("5, 7", { timeout: 10_000 });
    await expect(page.getByTestId("rum-cadence")).toContainText("beacons every 5 s while active, backing off to 7 s when idle");

    // Out of bounds (floor is 5 s): rejected with the parser's message, field reverts to the saved set.
    await field.fill("4, 9");
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH"),
      field.press("Enter"),
    ]);
    await expect(page.getByText(/between 5 and 3600/)).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue("5, 7");
    const stored = (await (await page.request.get("/api/me")).json()) as { rumFlushIntervals: number[] };
    expect(stored.rumFlushIntervals).toEqual([5, 7]);

    // A valid set is normalised (deduped, ascending) and reflected in the header line.
    await field.fill("11, 5,, 5, 7");
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH" && r.status() === 200),
      field.press("Enter"),
    ]);
    await expect(field).toHaveValue("5, 7, 11", { timeout: 10_000 });
    await expect(page.getByTestId("rum-cadence")).toContainText("backing off to 11 s when idle");
  });

  test("switching collection off shows the banner, discards beacons and stops the collector", async ({ page }) => {
    await page.goto("/admin/rum");
    await expect(page.getByRole("heading", { name: "Real user monitoring." })).toBeVisible({ timeout: 20_000 });
    const sw = page.getByRole("switch", { name: "Collect telemetry" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH"),
      sw.click(),
    ]);
    // Filtered: other live regions (e.g. a badge-earned toast from an earlier spec) are also role=status.
    await expect(page.getByRole("status").filter({ hasText: "Collection is off" })).toBeVisible({ timeout: 10_000 });
    await expect(sw).toHaveAttribute("aria-checked", "false");

    // Ingest now accepts-and-discards: 204, but nothing is written.
    const before = (await (await page.request.get("/api/admin/rum/summary?range=7")).json()) as { lastSampleAt: string | null };
    const res = await page.request.post("/api/rum", { data: { samples: [{ kind: "page_view", route: "/notifications", sessionId: SID }] } });
    expect(res.status()).toBe(204);
    const after = (await (await page.request.get("/api/admin/rum/summary?range=7")).json()) as { lastSampleAt: string | null; enabled: boolean };
    expect(after.enabled).toBe(false);
    expect(after.lastSampleAt).toBe(before.lastSampleAt);

    // The collector re-reads the flag (cachedGet is bypassed by a fresh navigation) and sends nothing.
    let posts = 0;
    page.on("request", (r) => { if (r.url().includes("/api/rum") && r.method() === "POST") posts += 1; });
    await page.goto("/catalog");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    expect(posts).toBe(0);

    // Restore.
    await page.request.patch("/api/admin/settings", { data: { rumEnabled: true } });
  });
});
