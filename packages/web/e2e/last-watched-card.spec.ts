// e2e: the last-watched card on Administration (§5). The card the admin last expanded or worked
// inside is remembered per browser (localStorage `skilly.admin.last-card`) and, on the next visit,
// auto-expanded, scrolled to the viewport centre and flashed. Also the §75.3 redirect, which rides
// on it: a platform admin who opens /namespaces lands here with the Namespaces card open. Runs
// against the dev stack (SKILLY_DEV_AUTH=1) — the dev user is a platform admin. Opt-in, not part of
// `pnpm -r test`.
//
// Namespace administration has the same behavior under `skilly.namespaces.last-card` (§30.6), but
// no e2e user can open that page: the dev sign-in provider signs in platform admins only, and they
// are redirected (§75.6). Its rules are the shared ones in lib/lastWatched.ts, unit-tested there.
//
// Hardening (helpers/ready.ts): every `page.reload()` here re-runs hydration, and the old spec
// clicked a card header the instant the server-rendered heading appeared — before the toggle
// handler existed — so the click was dropped and no key was written. Each navigation and reload
// now waits for the interactive shell, and stored values are polled rather than read once.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { NAV_TIMEOUT, gotoReady, reloadReady, shellReady } from "./helpers/ready";

const ADMIN_KEY = "skilly.admin.last-card";

const header = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });
const stored = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k), key);
// The Administration page renders its title and cards once its config has loaded - budget it
// like a navigation, not like a per-assertion check.
const adminLoaded = async (page: Page) => {
  await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible({ timeout: NAV_TIMEOUT });
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
    // The card must be below the first viewport (so the arrival actually scrolls) AND have enough
    // content under it while everything is collapsed for its header to reach the viewport centre:
    // the arrival scroll runs before the expand animation grows the body, so a card near the page
    // bottom can only be scrolled as far as the collapsed document allows. Email notifications
    // sits ~6 collapsed cards above the end of the page; Delete User Info (used before v2.7.0) is
    // now second-to-last since Currently online moved to the Monitoring page (§4) and no longer
    // qualifies.
    await page.evaluate((k) => localStorage.setItem(k, "email"), ADMIN_KEY);
    await reloadReady(page);
    await adminLoaded(page);
    const card = header(page, "Email notifications");
    await expect(card).toHaveAttribute("aria-expanded", "true");
    // The auto-expand wrote the card's own open preference, like a manual expand would.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("skilly.admin.card.email-open"))).toBe("1");
    // The header ends up centred (smooth scroll — poll until it settles).
    await expect.poll(() => offCentre(page, '[data-last-card="email"] [data-card-header]'), { timeout: 5_000 }).toBeLessThan(40);
    // The flash class is transient: it was on the card and is gone within ~1.5s.
    await expect(page.locator('[data-last-card="email"]')).not.toHaveClass(/card-flash/, { timeout: 4_000 });
    // The key persists — the behavior repeats on every visit.
    expect(await stored(page, ADMIN_KEY)).toBe("email");
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

  test("a platform admin who opens /namespaces lands here with the Namespaces card open (§75.3)", async ({ page }) => {
    // beforeEach left every card collapsed and nothing remembered. Come from a page outside the
    // admin group, so Back has somewhere distinct to return to.
    await gotoReady(page, "/catalog");
    // The page must never ask for the namespace list on a platform admin's behalf.
    const listRequests: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/namespaces/administered")) listRequests.push(r.url()); });

    await page.goto("/namespaces");
    await page.waitForURL((u) => u.pathname === "/admin", { timeout: NAV_TIMEOUT });
    await expect(shellReady(page)).toBeVisible({ timeout: NAV_TIMEOUT });
    await adminLoaded(page);

    // The redirect marked the Namespaces card as last watched; the page's own arrival opened it,
    // exactly as a manual expand would have (its open preference is written too).
    await expect(header(page, "Namespaces")).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => stored(page, ADMIN_KEY)).toBe("namespaces");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("skilly.admin.card.namespaces-open"))).toBe("1");
    await expect(page.getByLabel("Search namespaces")).toBeVisible();
    // No query string or anchor was added, and the list was never requested.
    expect(new URL(page.url()).search).toBe("");
    expect(new URL(page.url()).hash).toBe("");
    expect(listRequests).toEqual([]);

    // The sidebar has no Namespace administration item for a platform admin.
    await expect(page.locator("aside.sidebar").getByRole("link", { name: "Namespace administration" })).toHaveCount(0);

    // A replace, not a push: Back returns to where the admin came from, not to /namespaces (which
    // would bounce them straight back here).
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/catalog", { timeout: NAV_TIMEOUT });
  });
});
