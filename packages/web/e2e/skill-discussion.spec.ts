// e2e: the skill detail page's Discussion card (SKILLY_SPEC.md §24 "Skill discussion"). The card
// is EXPANDED by default with one global localStorage collapse preference; posts a comment with a
// version pill, sees it render newest-first, then deletes it as a moderator (the dev user is a
// platform admin). Runs against the dev stack (SKILLY_DEV_AUTH=1) using the seeded, installable
// `global/pdf-tools` skill; opt-in, not part of the default `pnpm -r test`. Self-cleaning: the
// comment it posts is removed at the end. Two mobile-viewport guards ride along: the card never
// paints outside itself at 375px (§14) and the composer's emoji picker stays on-screen.
//
// Hardening (helpers/ready.ts): every test starts from the hydrated shell with the thread's
// `GET …/discussion` in; Post is paired with its POST and the moderator delete with its confirm()
// AND its DELETE, so nothing is asserted on a timer. The deep-link test seeds the stored collapse
// with `addInitScript` BEFORE a fresh document load — the old spec set it on one page and then
// `goto`'d a hash-only change of the same URL, which the browser treats as a same-document
// navigation, so the mount effect under test never re-ran.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { acceptNextDialog, clickAndAwait, gotoLoaded, probe } from "./helpers/ready";

const SKILL = "/skills/global/pdf-tools";
const THREAD = /\/api\/skills\/global\/pdf-tools\/discussion\?offset=0/;
const POST = /\/api\/skills\/global\/pdf-tools\/discussion$/;
const DELETE = /\/api\/skills\/global\/pdf-tools\/discussion\/[^/?]+$/;
const OTHER_THREAD = /\/api\/skills\/global\/lint-fixer\/discussion\?offset=0/;

const header = (page: Page) => page.getByRole("button", { name: /^Discussion/ });
const card = (page: Page) => page.locator("section#discussion");
const composerOf = (page: Page) => page.getByRole("textbox", { name: "Add to the discussion" });

/** Post `body` and wait for the POST — the row renders from the thread refetch that follows. */
async function post(page: Page, body: string): Promise<void> {
  const composer = composerOf(page);
  await expect(composer).toBeVisible();
  await composer.fill(body);
  await clickAndAwait(page, () => card(page).getByRole("button", { name: /^Post/ }).click(), POST, { method: "POST" });
}

/** Moderator delete of the newest comment: confirm() accepted, DELETE observed. */
async function deleteNewest(page: Page): Promise<void> {
  const accepted = acceptNextDialog(page);
  await clickAndAwait(page, () => card(page).getByRole("button", { name: "delete" }).first().click(), DELETE, { method: "DELETE" });
  await accepted;
}

// All tests post into / read from the same seeded thread — keep them sequential.
test.describe.configure({ mode: "serial" });

test.describe("skill discussion (@global/pdf-tools)", () => {
  test("expanded by default → post a comment with a version pill → moderator delete", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, THREAD);

    // Expanded by default (§24) — no stored preference yet; the header shows the live count.
    await expect(header(page)).toBeVisible();
    await expect(header(page)).toHaveAttribute("aria-expanded", "true");

    // Post a unique comment (the composer is the mention-capable editable, not a textarea).
    const body = probe("discussion probe");
    await post(page, body);

    // It renders in the thread with a clickable version pill (vX.Y.Z).
    const comment = card(page).getByText(body, { exact: false });
    await expect(comment).toBeVisible();
    await expect(card(page).locator(".version-pill-btn").first()).toBeVisible();

    // Moderator delete (dev user is a platform admin) — the newest row is ours (newest-first).
    await deleteNewest(page);
    await expect(card(page).getByText(body, { exact: false })).toHaveCount(0);
  });

  test("collapsing is remembered globally in localStorage; expanding clears it", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, THREAD);
    const h = header(page);
    await expect(h).toHaveAttribute("aria-expanded", "true");

    // Collapse → the ONE global key is written (§24).
    await h.click();
    await expect(h).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBe("1");

    // A DIFFERENT skill's card honors the same preference on load (collapsed → no thread fetch;
    // wait for the hydrated shell and the header instead).
    await page.goto("/skills/global/lint-fixer");
    const other = header(page);
    await expect(other).toBeVisible({ timeout: 45_000 });
    await expect(other).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });

    // Expanding any card clears the preference — and fetches the thread.
    await clickAndAwait(page, () => other.click(), OTHER_THREAD);
    await expect(other).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBeNull();
  });

  test("#discussion deep link auto-expands even over a stored collapse, without overwriting it", async ({ page }) => {
    await devSignIn(page);
    // Seed the stored collapse BEFORE the document loads, then arrive by deep link in one fresh load.
    await page.addInitScript(() => localStorage.setItem("skilly.discussionCollapsed", "1"));
    await gotoLoaded(page, `${SKILL}#discussion`, THREAD); // expanded ⇒ the thread is fetched
    await expect(header(page)).toHaveAttribute("aria-expanded", "true");
    // …for this view only: the stored preference is untouched (§24).
    expect(await page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBe("1");
  });

  test("nothing spills past the card on a mobile viewport, even with unbreakable content", async ({ page }) => {
    // Regression: the expanded card's body wrapper is a grid item, and once data-settled released
    // the overflow clip its automatic minimum size grew to the MIN-CONTENT width of whatever was
    // inside (a long mention chip, a bare URL). At 375px the wrapper measured ~514px inside a
    // ~343px card, so the composer, the Post button, the message rows and the delete pill were all
    // laid out at that width and painted to the right of the card (§14 Narrow-viewport containment).
    await page.setViewportSize({ width: 375, height: 812 });
    await devSignIn(page);
    await gotoLoaded(page, `${SKILL}#discussion`, THREAD);

    const c = card(page);
    const body = c.locator(".admin-card-body");
    const composer = composerOf(page);
    await expect(composer).toBeVisible();

    // A comment carrying a run that CANNOT be broken at a space — the min-content driver.
    const lead = probe("overflow probe");
    await post(page, `${lead} https://example.com/${"segment/".repeat(20)}end`);
    await expect(c.getByText(lead, { exact: false })).toBeVisible();

    // The blowout only appeared AFTER the open animation released the clip — assert the settled state.
    await expect(body).toHaveAttribute("data-settled", "true", { timeout: 10_000 });

    // 1. The page itself never scrolls horizontally (1px slack for sub-pixel rounding).
    const doc = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(doc.scroll).toBeLessThanOrEqual(doc.view + 1);

    // 2. The animated body wrapper is clamped to the card — not to its content's min-content width.
    const cardBox = (await c.boundingBox())!;
    const innerBox = (await c.locator(".admin-card-body-inner").boundingBox())!;
    expect(innerBox.width).toBeLessThanOrEqual(cardBox.width + 1);

    // 3. …so the widgets sized off it stay inside the card's right edge.
    for (const el of [composer, c.getByRole("button", { name: /^Post/ })]) {
      const box = (await el.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    }

    await deleteNewest(page);
    await expect(c.getByText(lead, { exact: false })).toHaveCount(0);
  });

  test("emoji picker stays on-screen on a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await devSignIn(page);
    await gotoLoaded(page, `${SKILL}#discussion`, THREAD);

    const c = card(page);
    const emojiBtn = c.getByRole("button", { name: "Insert emoji" });
    await expect(emojiBtn).toBeVisible();
    await emojiBtn.click();

    // The picker panel (the only open role=menu in the card) must fit within the viewport —
    // regression guard: it used to anchor right:0 and overflow past the left edge on mobile.
    const panel = c.getByRole("menu");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  });
});
