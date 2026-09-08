// e2e: the last-watched card on Administration (§5) and Namespace administration (§30.6). The card
// the admin last expanded or worked inside is remembered per browser (localStorage
// `skilly.admin.last-card` / `skilly.namespaces.last-card`) and, on the next visit, auto-expanded
// (admin only), scrolled to the viewport centre and flashed. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) — the dev user is a platform admin. Opt-in, not part of `pnpm -r test`.
import { test, expect, devSignIn, type Page } from "./fixtures";

const ADMIN_KEY = "skilly.admin.last-card";
const NS_KEY = "skilly.namespaces.last-card";

const header = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });
const stored = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k), key);
const adminLoaded = async (page: Page) => {
  await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible();
};
// Distance of an element's vertical centre from the viewport's centre.
const offCentre = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
  }, selector);

test.describe("last-watched card — Administration (§5)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    await adminLoaded(page);
    // Start from a clean slate: every card collapsed, nothing remembered.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("skilly.admin.")) localStorage.removeItem(k);
    });
    await page.reload();
    await adminLoaded(page);
  });

  test("expanding a card remembers it; collapsing does not count, collapsing the remembered card forgets it", async ({ page }) => {
    await header(page, "Maximum upload size").click();
    expect(await stored(page, ADMIN_KEY)).toBe("upload");
    // Collapsing a different card leaves the remembered one alone.
    await header(page, "Contribution policy").click(); // expand → remembered
    expect(await stored(page, ADMIN_KEY)).toBe("contribution");
    await header(page, "Maximum upload size").click(); // collapse another
    expect(await stored(page, ADMIN_KEY)).toBe("contribution");
    // Collapsing the remembered card clears it.
    await header(page, "Contribution policy").click();
    expect(await stored(page, ADMIN_KEY)).toBeNull();
  });

  test("interacting inside a card body remembers that card", async ({ page }) => {
    await page.getByRole("button", { name: "Expand all" }).click();
    expect(await stored(page, ADMIN_KEY)).toBeNull(); // a bulk choice is not "watching"
    await page.getByLabel("Search namespaces").click();
    expect(await stored(page, ADMIN_KEY)).toBe("namespaces");
    // Expand all / Collapse all forgets it again.
    await page.getByRole("button", { name: "Collapse all" }).click();
    expect(await stored(page, ADMIN_KEY)).toBeNull();
  });

  test("on return the remembered card is expanded, centred and flashed", async ({ page }) => {
    // Remember a card far down the page, then leave it COLLAPSED (auto-expand must reopen it).
    await page.evaluate((k) => localStorage.setItem(k, "deleteuser"), ADMIN_KEY);
    await page.reload();
    await adminLoaded(page);
    const del = header(page, "Delete User Info");
    await expect(del).toHaveAttribute("aria-expanded", "true");
    // The auto-expand wrote the card's own open preference, like a manual expand would.
    expect(await page.evaluate(() => localStorage.getItem("skilly.admin.card.deleteuser-open"))).toBe("1");
    // The header ends up centred (smooth scroll — poll until it settles).
    await expect.poll(() => offCentre(page, '[data-last-card="deleteuser"] [data-card-header]'), { timeout: 5_000 }).toBeLessThan(40);
    // The flash class is transient: it was on the card and is gone within ~1.5s.
    await expect(page.locator('[data-last-card="deleteuser"]')).not.toHaveClass(/card-flash/, { timeout: 4_000 });
    // The key persists — the behavior repeats on every visit.
    expect(await stored(page, ADMIN_KEY)).toBe("deleteuser");
  });

  test("a URL #hash skips the whole arrival, and the key is kept", async ({ page }) => {
    await page.evaluate((k) => localStorage.setItem(k, "deleteuser"), ADMIN_KEY);
    await page.goto("/admin#top");
    await adminLoaded(page);
    await expect(header(page, "Delete User Info")).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await stored(page, ADMIN_KEY)).toBe("deleteuser");
  });

  test("a remembered id that names no card is cleared silently", async ({ page }) => {
    await page.evaluate((k) => localStorage.setItem(k, "retired-card"), ADMIN_KEY);
    await page.reload();
    await adminLoaded(page);
    await expect.poll(() => stored(page, ADMIN_KEY)).toBeNull();
  });

  test("the back-to-top button forgets the remembered card", async ({ page }) => {
    await header(page, "Namespaces").click();
    expect(await stored(page, ADMIN_KEY)).toBe("namespaces");
    await page.evaluate(() => window.scrollTo(0, 2000));
    const top = page.getByRole("button", { name: "Scroll back to top" });
    await expect(top).toBeVisible();
    await top.click();
    expect(await stored(page, ADMIN_KEY)).toBeNull();
  });
});

test.describe("last-watched card — Namespace administration (§30.6)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/namespaces");
    await expect(page.locator("[data-last-card]").first()).toBeVisible({ timeout: 20_000 });
    await page.evaluate((k) => localStorage.removeItem(k), NS_KEY);
  });

  test("interacting inside a namespace card remembers it; return flashes it; a stale id is cleared", async ({ page }) => {
    const cards = page.locator("[data-last-card]");
    const last = cards.last();
    const id = (await last.getAttribute("data-last-card"))!;
    // Any control inside the card counts — focus the review-policy checkbox.
    await last.getByRole("checkbox").focus();
    expect(await stored(page, NS_KEY)).toBe(id);

    await page.reload();
    const again = page.locator(`[data-last-card="${id}"]`);
    await expect(again).toBeVisible({ timeout: 20_000 });
    // Flash on arrival, then gone. (Scrolling is dropped when the card is already in view — with
    // the dev seed's short list it usually is — so the flash is the reliable arrival signal.)
    await expect(again).not.toHaveClass(/card-flash/, { timeout: 4_000 });
    expect(await stored(page, NS_KEY)).toBe(id);

    // A namespace no longer administered (or deleted) is forgotten on arrival.
    await page.evaluate((k) => localStorage.setItem(k, "00000000-0000-0000-0000-000000000000"), NS_KEY);
    await page.reload();
    await expect(page.locator("[data-last-card]").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => stored(page, NS_KEY)).toBeNull();
  });
});
