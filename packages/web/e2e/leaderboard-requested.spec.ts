// e2e: the leaderboard's "Requested" ranking + the Requests row action + the Requested-by view
// (SKILLY_SPEC.md §21/§26). Posts one request as the dev admin, then asserts: the Requested sort
// shows their row with an "N skill(s) requested" stat, their own row's Requests action lands on
// /requests?mine=1 in Mine mode, and the requested-by URL for their id renders the banner, the
// request, and its state pill. Cleans up the request (withdraw hard-deletes it).
import { test, expect, devSignIn } from "./fixtures";

test.describe("leaderboard: skills requested (§21/§26)", () => {
  test("Requested sort, Requests action, and the Requested-by view", async ({ page }) => {
    await devSignIn(page);
    const me = await (await page.request.get("/api/me")).json() as { userId: string };
    expect(me.userId).toBeTruthy();

    const title = `e2e lb-requested ${Date.now()}`;
    const created = await page.request.post("/api/requests", {
      multipart: { title, description: "posted by the leaderboard-requested e2e", toolHarness: "generic", categories: "[]" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json() as { id: string };

    try {
      // --- Requested sort: our row is on the board with the new stat. --------------------------
      await page.goto("/leaderboard");
      await expect(page.getByRole("heading", { name: "Leaderboard." })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Requested", exact: true }).click();
      // Own row = the one whose Requests action points at Mine.
      const ownRow = page.locator(".lb-row").filter({ has: page.locator('a[href="/requests?mine=1"]') });
      await expect(ownRow).toHaveCount(1, { timeout: 20_000 });
      await expect(ownRow).toContainText(/\d+ skills? requested/);
      // Every other row's Requests action is the requested-by view for THAT person.
      const others = page.locator(".lb-row").filter({ hasNot: page.locator('a[href="/requests?mine=1"]') });
      for (const href of await others.getByRole("link", { name: "Requests" }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")))) {
        expect(href).toMatch(/^\/requests\?requester=[0-9a-f-]{36}&by=/);
      }

      // --- Own row → Mine mode on the requests page. ---------------------------------------------
      await ownRow.getByRole("link", { name: "Requests" }).click();
      await expect(page).toHaveURL(/\/requests\?mine=1/);
      await expect(page.getByRole("button", { name: /Mine/ })).toHaveClass(/facet-on/, { timeout: 20_000 });
      await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();

      // --- Requested-by view for our own id (the same URL another viewer would use). --------------
      await page.goto(`/requests?requester=${me.userId}&by=${encodeURIComponent("Dev Admin")}`);
      const banner = page.locator(".requested-by-banner");
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText("Requested by");
      await expect(banner).toContainText("Dev Admin");
      // Mine and the admin state selector hide inside the view.
      await expect(page.getByRole("button", { name: /Mine/ })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Request state" })).toHaveCount(0);
      const card = page.getByRole("link", { name: new RegExp(title) });
      await expect(card).toBeVisible();
      await expect(card).toContainText("open"); // state pill shows in the view
      // ✕ clear returns to the org-wide list.
      await banner.getByRole("link", { name: /clear/ }).click();
      await expect(page).toHaveURL(/\/requests$/);
      await expect(page.locator(".requested-by-banner")).toHaveCount(0);

      // --- API guard: a malformed requester id is a 400, not a 500. ------------------------------
      const bad = await page.request.get("/api/requests?requester=not-a-uuid");
      expect(bad.status()).toBe(400);
    } finally {
      const del = await page.request.delete(`/api/requests/${id}`);
      expect(del.ok(), await del.text()).toBeTruthy();
    }
  });
});
