// e2e: the §34 full-text search engine through the real UI (SKILLY_SPEC.md §34.12 / §34.16).
// Runs against the dev stack (SKILLY_DEV_AUTH=1) with the seeded catalog — "PDF Tools" is described
// as "Read, merge, split and watermark PDF files directly from your agent."
//   - a multi-word query no skill fully matches falls back to partial matches, with the notice + tip
//   - an exclusion hides a skill; a zero-result search shows the syntax tip in the empty state
//   - a platform admin adds a synonym group on Administration → Search, and the catalog then finds a
//     skill through it
//   - Administration → Maintenance shows the search-index line
// The synonym group this spec creates is removed again through the API.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { gotoLoaded, clickAndAwait, NAV_TIMEOUT } from "./helpers/ready";

const SYNONYM = "zqfolio"; // a made-up word nothing in the catalog contains
const pdfTools = (page: Page) => page.locator(".card-grid, .rows").getByText("PDF Tools", { exact: true });
const cardHead = (page: Page, id: string) => page.locator(`section[data-last-card="${id}"] .admin-card-head`);

async function removeSynonymGroup(page: Page): Promise<void> {
  const res = await page.request.get("/api/admin/search/synonyms");
  const { groups } = (await res.json()) as { groups: { id: string; terms: string[] }[] };
  for (const g of groups.filter((x) => x.terms.includes(SYNONYM))) {
    await page.request.delete(`/api/admin/search/synonyms/${g.id}`);
  }
}

test.describe("full-text search (§34)", () => {
  test.describe.configure({ mode: "serial" });

  test("a query nothing fully matches shows partial matches with the notice and the syntax tip", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, `/catalog?q=${encodeURIComponent("pdf zqnothingmatches")}`, "/api/skills");
    const notice = page.locator(".search-partial");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("No skills match all of your words");
    await expect(notice).toContainText('use "quotes" for an exact phrase');
    await expect(pdfTools(page)).toBeVisible();
  });

  test("an exclusion hides a skill; a zero-result search carries the syntax tip", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/catalog?q=pdf", "/api/skills");
    await expect(pdfTools(page)).toBeVisible();
    await expect(page.locator(".search-partial")).toHaveCount(0);

    await gotoLoaded(page, `/catalog?q=${encodeURIComponent("pdf -merge")}`, "/api/skills");
    await expect(pdfTools(page)).toHaveCount(0);
    await expect(page.getByText("No skills match your filters")).toBeVisible();
    await expect(page.getByText(/-word to exclude, and OR between alternatives/)).toBeVisible();
  });

  test("a synonym group added on Administration → Search makes the catalog find a skill through it", async ({ page }) => {
    await devSignIn(page);
    await removeSynonymGroup(page); // a leftover from an aborted run would 422 the add below
    try {
      // Nothing matches the made-up word yet.
      await gotoLoaded(page, `/catalog?q=${SYNONYM}`, "/api/skills");
      await expect(pdfTools(page)).toHaveCount(0);

      await gotoLoaded(page, "/admin", ["/api/admin/namespaces", "/api/admin/search/synonyms"]);
      const head = cardHead(page, "search");
      if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("textbox", { name: "New synonym group" }).fill(`${SYNONYM}, pdf`);
      await clickAndAwait(page, () => page.getByRole("button", { name: "Add group" }).click(), "/api/admin/search/synonyms", { method: "POST" });
      await expect(page.locator(".synonym-row").filter({ hasText: SYNONYM })).toBeVisible({ timeout: NAV_TIMEOUT });

      await gotoLoaded(page, `/catalog?q=${SYNONYM}`, "/api/skills");
      await expect(pdfTools(page)).toBeVisible();
    } finally {
      await removeSynonymGroup(page);
    }
  });

  test("Administration → Maintenance shows the search-index line", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/admin", ["/api/admin/namespaces", "/api/admin/jobs/search-index"]);
    const head = cardHead(page, "maintenance");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    const body = page.locator('section[data-last-card="maintenance"]');
    await expect(body.getByText("Search index", { exact: true })).toBeVisible();
    await expect(body.getByText(/versions indexed|Rebuilding search index/)).toBeVisible();
    await expect(body.getByRole("button", { name: "Retry failed" })).toBeVisible();
  });
});
