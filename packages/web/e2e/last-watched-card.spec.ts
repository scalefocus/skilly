// e2e: the last-watched card on Administration (§5) and Namespace administration (§30.6). The card
// the admin last expanded or worked inside is remembered per browser (localStorage
// `skilly.admin.last-card` / `skilly.namespaces.last-card`) and, on the next visit, auto-expanded
// (admin only), scrolled to the viewport centre and flashed. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) — the dev user is a platform admin. Opt-in, not part of `pnpm -r test`.
//
// Hardening (helpers/ready.ts): every `page.reload()` here re-runs hydration, and the old spec
// clicked a card header the instant the server-rendered heading appeared — before the toggle
// handler existed — so the click was dropped and no key was written. Each navigation and reload
// now waits for the interactive shell, and stored values are polled rather than read once.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { NAV_TIMEOUT, gotoLoaded, gotoReady, reloadReady } from "./helpers/ready";

const ADMIN_KEY = "skilly.admin.last-card";
const NS_KEY = "skilly.namespaces.last-card";

const header = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });
const stored = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k), key);
// The Administration page renders its title and cards once its config has loaded - budget it
// like a navigation, not like a per-assertion check.
const adminLoaded = async (page: Page) => {
  await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible({ timeout: NAV_TIMEOUT });
};
test.describe("last-watched card — Administration (§5)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/admin");
    await adminLoaded(page);
    // Start from a clean slate: every card collapsed, nothing remembered.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("skilly.admin.")) localStorage.removeItem(k);
    });
    await reloadReady(page);
    await adminLoaded(page);
  });

  test("expanding a card remembers it; collapsing does not count, collapsing the remembered card forgets it", async ({ page }) => {
    await header(page, "Maximum upload size").click();
    await expect(header(page, "Maximum upload size")).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => stored(page, ADMIN_KEY)).toBe("upload");
    // Expanding a different card moves the memory to it.
    await header(page, "Contribution policy").click();
    await expect(header(page, "Contribution policy")).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => stored(page, ADMIN_KEY)).toBe("contribution");
    // Collapsing ANOTHER card leaves the remembered one alone.
    await header(page, "Maximum upload size").click();
    await expect(header(page, "Maximum upload size")).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => stored(page, ADMIN_KEY)).toBe("contribution");
    // Collapsing the remembered card clears it.
    await header(page, "Contribution policy").click();
    await expect(header(page, "Contribution policy")).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => stored(page, ADMIN_KEY)).toBeNull();
  });

  test("interacting inside a card body remembers that card", async ({ page }) => {
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(page.getByRole("button", { name: "Collapse all" })).toBeVisible();
    expect(await stored(page, ADMIN_KEY)).toBeNull(); // a bulk choice is not "watching"
    await page.getByLabel("Search namespaces").click();
    await expect.poll(() => stored(page, ADMIN_KEY)).toBe("namespaces");
    // Expand all / Collapse all forgets it again.
    await page.getByRole("button", { name: "Collapse all" }).click();
    await expect.poll(() => stored(page, ADMIN_KEY)).toBeNull();
  });

  test("on return the remembered card is expanded, centred and flashed", async ({ page }) => {
    // Remember a card far down the page, then leave it COLLAPSED (auto-expand must reopen it).
    await page.evaluate((k) => localStorage.setItem(k, "deleteuser"), ADMIN_KEY);
    await reloadReady(page);
    await adminLoaded(page);
    const del = header(page, "Delete User Info");
    await expect(del).toHaveAttribute("aria-expanded", "true");
    // The auto-expand wrote the card's own open preference, like a manual expand would.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("skilly.admin.card.deleteuser-open"))).toBe("1");
    // The header ends up centred (smooth scroll — poll until it settles) — or as close to centred
    // as the document allows: since Currently online moved to the Monitoring page (v2.7.0, §4),
    // Delete User Info is the second-to-last card, and with everything else collapsed the page can
    // run out of content below it before the header reaches the middle. `scrollIntoView` then
    // stops at the document bottom, which is the correct behavior, so accept "pinned to the
    // bottom" as well — as long as the header is fully in view.
    await expect.poll(() => page.evaluate((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      const off = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
      const inView = r.top >= 0 && r.bottom <= window.innerHeight;
      const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 1;
      return inView && (off < 40 || atBottom);
    }, '[data-last-card="deleteuser"] [data-card-header]'), { timeout: 5_000 }).toBe(true);
    // The flash class is transient: it was on the card and is gone within ~1.5s.
    await expect(page.locator('[data-last-card="deleteuser"]')).not.toHaveClass(/card-flash/, { timeout: 4_000 });
    // The key persists — the behavior repeats on every visit.
    expect(await stored(page, ADMIN_KEY)).toBe("deleteuser");
  });

  test("a URL #hash skips the whole arrival, and the key is kept", async ({ page }) => {
    await page.evaluate((k) => localStorage.setItem(k, "deleteuser"), ADMIN_KEY);
    await gotoReady(page, "/admin#top");
    await adminLoaded(page);
    await expect(header(page, "Delete User Info")).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await stored(page, ADMIN_KEY)).toBe("deleteuser");
  });

  test("a remembered id that names no card is cleared silently", async ({ page }) => {
    await page.evaluate((k) => localStorage.setItem(k, "retired-card"), ADMIN_KEY);
    await reloadReady(page);
    await adminLoaded(page);
    await expect.poll(() => stored(page, ADMIN_KEY)).toBeNull();
  });

  test("the back-to-top button forgets the remembered card", async ({ page }) => {
    await header(page, "Namespaces").click();
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => stored(page, ADMIN_KEY)).toBe("namespaces");
    await page.evaluate(() => window.scrollTo(0, 2000));
    const top = page.getByRole("button", { name: "Scroll back to top" });
    await expect(top).toBeVisible();
    await top.click();
    await expect.poll(() => stored(page, ADMIN_KEY)).toBeNull();
  });
});

test.describe("last-watched card — Namespace administration (§30.6)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/namespaces", "/api/namespaces/administered");
    await expect(page.locator("[data-last-card]").first()).toBeVisible();
    await page.evaluate((k) => localStorage.removeItem(k), NS_KEY);
  });

  test("interacting inside a namespace card remembers it; return flashes it; a stale id is cleared", async ({ page }) => {
    const cards = page.locator("[data-last-card]");
    const last = cards.last();
    const id = (await last.getAttribute("data-last-card"))!;
    // Any control inside the card counts — focus the review-policy switch (v1.146.1's `Switch`).
    await last.getByRole("switch").first().focus();
    await expect.poll(() => stored(page, NS_KEY)).toBe(id);

    await reloadReady(page);
    const again = page.locator(`[data-last-card="${id}"]`);
    await expect(again).toBeVisible();
    // Flash on arrival, then gone. (Scrolling is dropped when the card is already in view — with
    // the dev seed's short list it usually is — so the flash is the reliable arrival signal.)
    await expect(again).not.toHaveClass(/card-flash/, { timeout: 4_000 });
    expect(await stored(page, NS_KEY)).toBe(id);

    // A namespace no longer administered (or deleted) is forgotten on arrival.
    await page.evaluate((k) => localStorage.setItem(k, "00000000-0000-0000-0000-000000000000"), NS_KEY);
    await reloadReady(page);
    await expect(page.locator("[data-last-card]").first()).toBeVisible();
    await expect.poll(() => stored(page, NS_KEY)).toBeNull();
  });
});
