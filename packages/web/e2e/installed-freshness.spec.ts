// e2e: installed-version freshness on the Installed Skills page (SKILLY_SPEC.md §23, §39). Runs
// against the dev stack (SKILLY_DEV_AUTH=1) using db/seed.dev.sql, whose stamps put the three
// dev-user installs in three states: pdf-tools pinned 1.1.0 = latest stable → current (the
// 1.2.0-beta.1 never makes it behind); lint-fixer tracks latest, last served 2.2.0 while 2.3.0 is
// latest → BEHIND; secret-helper pinned 0.9.0 → current, inactive. Read-only: never uninstalls.
//
// The "re-clone → row flips to up to date" half of the §39.3 e2e needs a real git clone through
// the gateway, which this dev-server suite has no git repos for; the stamp is covered at the HTTP
// level by packages/worker/src/git/server.test.ts and at the SQL level by installs.dbtest.ts.
import { test, expect, devSignIn } from "./fixtures";

const PDF = 'a[href="/skills/global/pdf-tools"]';
const LINT = 'a[href="/skills/global/lint-fixer"]';
const SECRET = 'a[href="/skills/team-a/secret-helper"]';

test.describe("installed-version freshness (§23)", () => {
  test("rows show installed vs latest, a Behind badge, and the chip filters to behind rows (mirrored to ?filter=behind)", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/installed");

    const chip = page.getByRole("button", { name: "Behind latest" });
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    // All three list; each carries a freshness line.
    await expect(page.locator(PDF)).toBeVisible();
    await expect(page.locator(LINT)).toBeVisible();
    await expect(page.locator(SECRET)).toBeVisible();
    const lintRow = page.locator(".installed-row", { has: page.locator(LINT) });
    const pdfRow = page.locator(".installed-row", { has: page.locator(PDF) });
    await expect(lintRow.locator(".install-freshness")).toHaveAttribute("data-freshness", "behind");
    await expect(lintRow.locator(".install-freshness")).toContainText(/cloned v2\.2\.0 on .+ · latest v2\.3\.0/);
    await expect(lintRow.getByText("Behind", { exact: true })).toBeVisible();
    await expect(pdfRow.locator(".install-freshness")).toHaveAttribute("data-freshness", "current");
    await expect(pdfRow.locator(".install-freshness")).toContainText("installed v1.1.0 · up to date");
    await expect(pdfRow.getByText("Behind", { exact: true })).toHaveCount(0);

    // Chip on → only the behind row, URL carries ?filter=behind (replace, not push).
    await chip.click();
    await expect(page).toHaveURL(/[?&]filter=behind\b/, { timeout: 10_000 });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(LINT)).toBeVisible();
    await expect(page.locator(PDF)).toHaveCount(0);
    await expect(page.locator(SECRET)).toHaveCount(0);

    // Composes with the header search: a query matching only up-to-date rows → the search miss
    // state (not "Everything is up to date"), naming the chip in its hint.
    const search = page.getByPlaceholder("Search installed skills…");
    await search.fill("pdf");
    await expect(page.getByText(/No installed skills match/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Behind latest/).last()).toBeVisible();
    await expect(page).toHaveURL(/[?&]filter=behind\b/); // the chip survives the search

    // Clearing the search restores the behind row; chip off restores everything.
    await search.fill("");
    await expect(page.locator(LINT)).toBeVisible({ timeout: 10_000 });
    await chip.click();
    await expect(page).not.toHaveURL(/filter=behind/, { timeout: 10_000 });
    await expect(page.locator(PDF)).toBeVisible();
    await expect(page.locator(SECRET)).toBeVisible();
  });

  test("?filter=behind on arrival seeds the chip; the API row carries the freshness fields", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/installed?filter=behind");
    const chip = page.getByRole("button", { name: "Behind latest" });
    await expect(chip).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect(page.locator(LINT)).toBeVisible();
    await expect(page.locator(PDF)).toHaveCount(0);

    const res = await page.request.get("/api/installs");
    expect(res.ok()).toBeTruthy();
    const { installs } = (await res.json()) as { installs: Array<Record<string, unknown>> };
    const lint = installs.find((i) => i.skillSlug === "lint-fixer");
    expect(lint).toMatchObject({ lastServedSemver: "2.2.0", latestSemver: "2.3.0", freshness: "behind", pinnedSemver: null });
    expect(typeof lint?.lastClonedAt).toBe("string");
    const pdf = installs.find((i) => i.skillSlug === "pdf-tools");
    expect(pdf).toMatchObject({ lastServedSemver: "1.1.0", latestSemver: "1.1.0", freshness: "current" });
  });
});
