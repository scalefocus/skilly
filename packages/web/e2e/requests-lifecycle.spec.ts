// e2e: the skill-requests lifecycle (SKILLY_SPEC.md §26). A user files a "wanted skill" request; it
// appears in the org-wide open list; the requester (or a platform admin) can close it. We create a
// request via the API (multipart, text-only), confirm it renders on /requests, then delete it —
// self-cleaning. (The header-search filter on this page is covered by requests-search.spec.ts.)
import { test, expect, devSignIn } from "./fixtures";

test.describe("skill requests lifecycle (§26)", () => {
  test("create a request → it lists → delete it", async ({ page }) => {
    await devSignIn(page);
    const title = `E2E Wanted Skill ${Date.now().toString(36)}`;

    const created = await page.request.post("/api/requests", {
      multipart: {
        title,
        description: "An e2e-created request (safe to delete).",
        toolHarness: "generic",
        categories: "[]",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();

    try {
      await page.goto("/requests");
      await expect(page.getByRole("heading", { name: "Requested skills." })).toBeVisible({ timeout: 20_000 });
      // A freshly-filed request is open org-wide, so it shows in the default list.
      await expect(page.getByText(title)).toBeVisible({ timeout: 20_000 });
    } finally {
      const del = await page.request.delete(`/api/requests/${id}`);
      expect(del.ok(), await del.text()).toBeTruthy();
    }
  });
});
