// e2e: real user monitoring (SKILLY_SPEC.md §32) — the browser collector beacons page views for the
// pages the dev admin visits, the /admin/rum page lists those routes (plus the pinned "All routes"
// row) and drills down to the acting user, the beacon's trust boundary answers 401 signed-out and
// 400 to a malformed batch, and flipping the header switch off shows the banner and stops the
// beacon. Runs against the dev stack (SKILLY_DEV_AUTH=1) — serial, because it flips a platform
// setting the shared dev user sees.
import { test, expect, devSignIn, type Page } from "./fixtures";

test.describe.configure({ mode: "serial" });

const SID = "e2e-rum-session-0001";

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

test.describe("real user monitoring (§32)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    // Make sure collection is on (a previous aborted run may have left it off).
    await page.request.patch("/api/admin/settings", { data: { rumEnabled: true, rumSampleRate: 100 } });
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

    // 90d / All have no user dimension: the expander says so instead of loading.
    await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByTestId("rum-routes")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("rum-routes").locator("tbody tr.rum-row").first().click();
    await expect(page.getByText("Switch to 7d or 30d to see who was affected.")).toBeVisible();
  });

  test("the sidebar links the page for the admin and the presence label resolves", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: "Real user monitoring" });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveAttribute("href", "/admin/rum");
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
    await expect(page.getByRole("status")).toContainText("Collection is off", { timeout: 10_000 });
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
