// e2e: the global header search doubles as the usage filter on /usage (SKILLY_SPEC.md §10/§21).
// On /usage the top-bar box reads "Search usage…" (not "Search the registry…"), the registry
// typeahead is suppressed, and typing live-filters the usage list server-side (ILIKE over
// title/slug/namespace) by writing ?q= — seeded from and synced to the URL like the catalog.
// Runs against the dev stack (SKILLY_DEV_AUTH=1, a platform-admin dev user) using the seeded
// `global/pdf-tools` skill; opt-in, not part of the default `pnpm -r test`.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as
// e2e/featured-skills.spec.ts. Shares the page cookie jar.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
  expect(res.ok()).toBeTruthy();
}

test.describe("usage header search (@global/pdf-tools)", () => {
  test('header box reads "Search usage…" and live-filters the usage list via ?q=', async ({ page }) => {
    await devSignIn(page);
    await page.goto("/usage");

    // The one top-bar box is relabelled on /usage. Its presence also confirms the dev session is
    // authenticated (the box only renders when signed in). First nav pays the route compile.
    const search = page.getByRole("textbox", { name: /search usage/i });
    await expect(search).toBeVisible({ timeout: 20_000 });
    await expect(search).toHaveAttribute("placeholder", "Search usage…");

    // The seeded skill is in the (unfiltered) entitled list to start with.
    const pdfRow = page.getByText("@global/pdf-tools", { exact: true });
    await expect(pdfRow).toBeVisible({ timeout: 20_000 });

    // Typing a matching term writes ?q= (debounced) and the list refetches to the matches only.
    await search.fill("pdf");
    await expect(page).toHaveURL(/\/usage\?(?:.*&)?q=pdf/, { timeout: 10_000 });
    await expect(pdfRow).toBeVisible();

    // A non-matching term drives the list empty (server-side ILIKE returns nothing).
    await search.fill("zzq-nomatch-usage");
    await expect(page).toHaveURL(/q=zzq-nomatch-usage/, { timeout: 10_000 });
    await expect(page.getByText("No skills match your filters")).toBeVisible();
    await expect(pdfRow).toHaveCount(0);

    // Clearing restores the full list and drops ?q= from the URL.
    await search.fill("");
    await expect(page).toHaveURL(/\/usage$/, { timeout: 10_000 });
    await expect(pdfRow).toBeVisible();

    // On /usage the registry typeahead dropdown is suppressed — typing must not open it.
    await search.fill("pdf");
    await expect(page).toHaveURL(/q=pdf/, { timeout: 10_000 });
    await expect(page.locator("ul.search-ac")).toHaveCount(0);

    // Cleanup: leave the URL without a lingering query.
    await search.fill("");
    await expect(page).toHaveURL(/\/usage$/, { timeout: 10_000 });
  });
});
