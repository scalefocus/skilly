// e2e: the leaderboard's "Requested" ranking + the Requests row action + the Requested-by view
// (SKILLY_SPEC.md §21/§26). Posts one request as the dev admin, then asserts: the Requested sort
// shows their row with an "N skill(s) requested" stat, their own row's Requests action lands on
// /requests?mine=1 in Mine mode, and the requested-by URL for their id renders the banner, the
// request, and its state pill. Cleans up the request (withdraw hard-deletes it).
//
// Hardening (helpers/ready.ts): one mega-test became three focused ones sharing a per-test
// fixture, so a hiccup in one surface no longer fails the other two. The sort click is paired
// with its `/api/leaderboard?…sort=requested` fetch, the row action with the URL change it must
// produce, and every navigation starts from the hydrated shell.
//
// Requires the e2e server to run with LEADERBOARD_CACHE_TTL_MS=0 (playwright.config webServer env;
// both CI e2e stages): the board is cached per (window, sort) for 60s and /api/leaders primes that
// cache on every page load, so without it the request created in beforeEach is invisible to the
// UI's Requested sort until the TTL lapses - a read-your-writes race that surfaced once the suite
// got fast enough to run two page loads inside one TTL window.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { NAV_TIMEOUT, clickAndAwait, gotoLoaded, gotoReady, probe } from "./helpers/ready";

const escapeRx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const LEADERBOARD_INITIAL = "/api/leaderboard?window=all&sort=installs";
const LEADERBOARD_REQUESTED = "/api/leaderboard?window=all&sort=requested";
// Own row = the one whose Requests action points at Mine.
const ownRow = (page: Page) => page.locator(".lb-row").filter({ has: page.locator('a[href="/requests?mine=1"]') });

// The three tests share the dev user's request rows — never interleave them.
test.describe.configure({ mode: "serial" });

test.describe("leaderboard: skills requested (§21/§26)", () => {
  let userId: string;
  let title: string;
  let requestId: string;

  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    const me = (await (await page.request.get("/api/me")).json()) as { userId: string };
    expect(me.userId).toBeTruthy();
    userId = me.userId;
    title = probe("lb-requested");
    const created = await page.request.post("/api/requests", {
      multipart: { title, description: "posted by the leaderboard-requested e2e", toolHarness: "generic", categories: "[]" },
    });
    expect(created.status(), await created.text()).toBe(201);
    requestId = ((await created.json()) as { id: string }).id;
  });

  test.afterEach(async ({ page }) => {
    const del = await page.request.delete(`/api/requests/${requestId}`);
    expect(del.status(), await del.text()).toBeLessThan(500); // 200 gone; 404 already gone
  });

  test("the Requested sort ranks the requester with a skills-requested stat", async ({ page }) => {
    await gotoLoaded(page, "/leaderboard", LEADERBOARD_INITIAL);
    await expect(page.getByRole("heading", { name: "Leaderboard." })).toBeVisible();
    await clickAndAwait(page, () => page.getByRole("button", { name: "Requested", exact: true }).click(), LEADERBOARD_REQUESTED);

    await expect(ownRow(page)).toHaveCount(1);
    await expect(ownRow(page)).toContainText(/\d+ skills? requested/);
    // Every other row's Requests action is the requested-by view for THAT person.
    const others = page.locator(".lb-row").filter({ hasNot: page.locator('a[href="/requests?mine=1"]') });
    const hrefs = await others.getByRole("link", { name: "Requests" }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    for (const href of hrefs) expect(href).toMatch(/^\/requests\?requester=[0-9a-f-]{36}&by=/);
  });

  test("the own row's Requests action lands in Mine mode, listing the request", async ({ page }) => {
    await gotoLoaded(page, "/leaderboard", LEADERBOARD_INITIAL);
    await clickAndAwait(page, () => page.getByRole("button", { name: "Requested", exact: true }).click(), LEADERBOARD_REQUESTED);
    await expect(ownRow(page)).toHaveCount(1);

    // A client-side navigation: pair the click with the URL it must reach.
    await Promise.all([
      page.waitForURL(/\/requests\?mine=1/, { timeout: NAV_TIMEOUT }),
      ownRow(page).getByRole("link", { name: "Requests" }).click(),
    ]);
    await expect(page.getByRole("button", { name: /Mine/ })).toHaveClass(/facet-on/, { timeout: 20_000 });
    await expect(page.getByRole("link", { name: escapeRx(title) })).toBeVisible({ timeout: 20_000 });
  });

  test("the Requested-by view banners the requester, shows the state pill, and clears", async ({ page }) => {
    // The same URL another viewer would use for this person.
    await gotoReady(page, `/requests?requester=${userId}&by=${encodeURIComponent("Dev Admin")}`);
    const banner = page.locator(".requested-by-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("Requested by");
    await expect(banner).toContainText("Dev Admin");
    // Mine and the admin state selector hide inside the view.
    await expect(page.getByRole("button", { name: /Mine/ })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Request state" })).toHaveCount(0);
    const card = page.getByRole("link", { name: escapeRx(title) });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("open"); // state pill shows in the view

    // ✕ clear returns to the org-wide list.
    await Promise.all([
      page.waitForURL(/\/requests$/, { timeout: NAV_TIMEOUT }),
      banner.getByRole("link", { name: /clear/ }).click(),
    ]);
    await expect(page.locator(".requested-by-banner")).toHaveCount(0);

    // API guard: a malformed requester id is a 400, not a 500.
    const bad = await page.request.get("/api/requests?requester=not-a-uuid");
    expect(bad.status()).toBe(400);
  });
});
