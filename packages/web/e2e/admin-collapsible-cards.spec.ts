// e2e: every Administration card is a collapsible panel (SKILLY_SPEC.md §5). Cards start collapsed,
// each card's open/closed choice persists per browser (localStorage `skilly.admin.card.<id>-open`),
// and an Expand all / Collapse all control drives them together. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) — the dev user is a platform admin, so /admin renders. Opt-in, not part of the
// default `pnpm -r test`.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as
// e2e/shots.mjs. page.request shares the page's cookie jar, so the next navigation is authed.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  expect(res.ok()).toBeTruthy();
}

// A card's always-visible header is a button whose accessible name starts with the card title.
const header = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });

test.describe("Administration collapsible cards (§5)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    // The page renders its cards once the admin config loads.
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible();
  });

  test("cards start collapsed", async ({ page }) => {
    await expect(header(page, "Contribution policy")).toHaveAttribute("aria-expanded", "false");
    await expect(header(page, "Currently online")).toHaveAttribute("aria-expanded", "false");
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "false");
  });

  test("a collapsed card shows only its header — no body content peeks out", async ({ page }) => {
    // Regression (v1.115.1): the inner wrapper's bottom padding fed the 0fr track's minimum
    // size, leaving ~22px of body content visible under the header of every collapsed card.
    const heights = await page.$$eval(".admin-card", (cards) =>
      cards
        .filter((c) => c.querySelector(".admin-card-head")?.getAttribute("aria-expanded") === "false")
        .map((c) => Math.round(c.querySelector(".admin-card-body")!.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBe(0);
  });

  test("clicking a header toggles that card only", async ({ page }) => {
    const contribution = header(page, "Contribution policy");
    await contribution.click();
    await expect(contribution).toHaveAttribute("aria-expanded", "true");
    // A different card stays collapsed.
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "false");
    await contribution.click();
    await expect(contribution).toHaveAttribute("aria-expanded", "false");
  });

  test("a card's open state persists across a reload", async ({ page }) => {
    await header(page, "Maximum upload size").click();
    await expect(header(page, "Maximum upload size")).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible();
    await expect(header(page, "Maximum upload size")).toHaveAttribute("aria-expanded", "true");
    // A card left collapsed stays collapsed after the reload.
    await expect(header(page, "Contribution policy")).toHaveAttribute("aria-expanded", "false");
  });

  test("Expand all / Collapse all drives every card and persists", async ({ page }) => {
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(header(page, "Contribution policy")).toHaveAttribute("aria-expanded", "true");
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "true");
    // The control flips to Collapse all once everything is open.
    const collapseAll = page.getByRole("button", { name: "Collapse all" });
    await expect(collapseAll).toBeVisible();
    await collapseAll.click();
    await expect(header(page, "Contribution policy")).toHaveAttribute("aria-expanded", "false");
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "false");
    // The bulk choice sticks per browser like an individual toggle.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible();
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "false");
  });

  test("the SCIM sync pills stay visible while the card is collapsed", async ({ page }) => {
    // The ok/warn pills ride in the header accessory (answer 2a) — a broken sync must not hide.
    const scimHeader = header(page, "Identity sync \\(SCIM\\)");
    await expect(scimHeader).toHaveAttribute("aria-expanded", "false");
    await expect(scimHeader.getByText(/synced/).first()).toBeVisible();
  });
});
