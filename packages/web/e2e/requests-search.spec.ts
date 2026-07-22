// e2e: the Requested skills page (/requests) has NO search input of its own — the top-bar box is
// repurposed as its live filter (§10/§26). On /requests the box relabels to "Search requests…",
// suppresses the registry typeahead, and live-filters the list via ?q= (2-char floor, ~250ms
// debounce, router.replace), exactly like the catalog does for the registry. Runs against the dev
// stack (SKILLY_DEV_AUTH=1); opt-in, not part of the default `pnpm -r test`. No requests are
// seeded, so the test creates its own via POST /api/requests, tagged with a unique run token so the
// assertions are robust against any leftover rows from earlier runs.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as the
// other specs. page.request shares the page's cookie jar, so the next navigation is authed.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  expect(res.ok()).toBeTruthy();
}

// Post a request as the signed-in dev user (text-only multipart form, §26).
async function createRequest(page: Page, title: string) {
  const res = await page.request.post("/api/requests", {
    multipart: { title, description: `Auto-created by requests-search.spec: ${title}`, toolHarness: "generic" },
  });
  expect(res.status(), await res.text()).toBe(201);
}

// The top-bar search box, addressed by its /requests aria-label.
const searchBox = (page: Page) => page.getByRole("textbox", { name: "Search requests" });

test("the top-bar search relabels to 'Search requests' on /requests and the page has no search box of its own", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/requests");
  await expect(page.getByRole("heading", { name: "Requested skills." })).toBeVisible();

  // The top-bar box carries the requests-specific placeholder + label…
  await expect(searchBox(page)).toBeVisible();
  await expect(searchBox(page)).toHaveAttribute("placeholder", "Search requests…");
  // …and there is NO page-local search box in the content area (it moved to the top bar).
  await expect(page.locator(".content .search")).toHaveCount(0);

  // Control: the catalog is unchanged — the same box stays the registry search there.
  await page.goto("/catalog");
  await expect(page.getByRole("textbox", { name: "Search skills" })).toHaveAttribute("placeholder", "Search the registry…");
});

test("typing in the top-bar search live-filters the requests list via ?q= (and shared ?q= links seed it)", async ({ page }) => {
  await devSignIn(page);
  const token = `qa${Date.now()}`;
  const titleA = `${token} alpha wobbleframe`;
  const titleB = `${token} beta quuxensteil`;
  await createRequest(page, titleA);
  await createRequest(page, titleB);

  await page.goto("/requests");
  const cardA = page.getByRole("heading", { name: titleA });
  const cardB = page.getByRole("heading", { name: titleB });

  // Both this run's requests are present in the unfiltered list.
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeVisible();

  // Narrow to just A: typing writes ?q= and the list re-queries (ILIKE title/description).
  await searchBox(page).fill("wobbleframe");
  await expect(page).toHaveURL(/[?&]q=wobbleframe/);
  await expect(cardA).toBeVisible();
  await expect(cardB).toHaveCount(0);

  // Clearing restores the full list and drops ?q= from the URL.
  await searchBox(page).fill("");
  await expect(page).toHaveURL(/\/requests$/);
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeVisible();

  // A shared/bookmarked ?q= link seeds the box and lands pre-filtered.
  await page.goto("/requests?q=wobbleframe");
  await expect(searchBox(page)).toHaveValue("wobbleframe");
  await expect(cardA).toBeVisible();
  await expect(cardB).toHaveCount(0);
});
