// e2e: the Installed Skills page header search (SKILLY_SPEC.md §23). On /installed the app-shell
// top-bar box is relabelled "Search installed skills…" and becomes a client-side live filter of the
// installed list (case-insensitive substring over title + @ns/slug), mirrored to ?q=; the registry
// typeahead is suppressed and Enter just blurs. Runs against the dev stack (SKILLY_DEV_AUTH=1) using
// the seeded dev-user installs (pdf-tools, lint-fixer, secret-helper — see db/seed.dev.sql). Opt-in,
// not part of the default `pnpm -r test`. Read-only: it never uninstalls, so the seed is preserved.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as the other
// dev-stack specs. Shares the page cookie jar.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
  expect(res.ok()).toBeTruthy();
}

const PDF = 'a[href="/skills/global/pdf-tools"]';
const LINT = 'a[href="/skills/global/lint-fixer"]';
const SECRET = 'a[href="/skills/team-a/secret-helper"]';

test.describe("installed skills header search (§23)", () => {
  test("relabelled box live-filters the installed list on title / namespace / slug", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/installed");

    const search = page.getByPlaceholder("Search installed skills…");
    // First navigation on a dev server pays the on-demand route compile — allow generous time.
    await expect(search).toBeVisible({ timeout: 20_000 });

    // All three seeded installs list initially.
    await expect(page.locator(PDF)).toBeVisible();
    await expect(page.locator(LINT)).toBeVisible();
    await expect(page.locator(SECRET)).toBeVisible();

    // Title match: "pdf" narrows to PDF Tools only, and mirrors into ?q=.
    await search.fill("pdf");
    await expect(page).toHaveURL(/[?&]q=pdf\b/, { timeout: 10_000 });
    await expect(page.locator(PDF)).toBeVisible();
    await expect(page.locator(LINT)).toHaveCount(0);
    await expect(page.locator(SECRET)).toHaveCount(0);

    // Namespace-slug match: "team-a" narrows to the team-a install only.
    await search.fill("team-a");
    await expect(page.locator(SECRET)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(PDF)).toHaveCount(0);
    await expect(page.locator(LINT)).toHaveCount(0);

    // Namespace match across rows: "global" keeps both global installs, drops the team-a one.
    await search.fill("global");
    await expect(page.locator(PDF)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(LINT)).toBeVisible();
    await expect(page.locator(SECRET)).toHaveCount(0);

    // No match → the distinct empty state (NOT "No installs yet"), inactive rows included in the miss.
    await search.fill("zzzznope");
    await expect(page.getByText(/No installed skills match/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(PDF)).toHaveCount(0);

    // Clearing restores the full list.
    await search.fill("");
    await expect(page.locator(PDF)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(LINT)).toBeVisible();
    await expect(page.locator(SECRET)).toBeVisible();
  });

  test("the registry typeahead is suppressed here; Enter does not jump to the catalog", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/installed");

    const search = page.getByPlaceholder("Search installed skills…");
    await expect(search).toBeVisible({ timeout: 20_000 });

    // Typing does NOT open the registry suggestion dropdown ("See all results in catalog →").
    await search.fill("pdf");
    await expect(page.getByText(/See all results in catalog/i)).toHaveCount(0);

    // Enter stays on /installed (no push to /catalog?q=…).
    await search.press("Enter");
    await expect(page).toHaveURL(/\/installed(\?|$)/);
  });

  test("the relabel is scoped to /installed — the catalog keeps the registry placeholder", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/catalog");
    await expect(page.getByPlaceholder("Search the registry…")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByPlaceholder("Search installed skills…")).toHaveCount(0);
  });
});
