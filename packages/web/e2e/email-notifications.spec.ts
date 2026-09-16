// e2e: the §12 email-notifications surfaces — the per-user profile toggle (default ON,
// persisted via PATCH /api/me) and the Administration "Email notifications" card (collapsed
// by default; status pill; wrapper editor enforcing the single [SYSTEM MESSAGE] placeholder
// before Save enables). Runs against the dev stack (SKILLY_DEV_AUTH=1, dev user is a
// platform admin); opt-in, not part of the default `pnpm -r test`.
//
// Hardening (helpers/ready.ts): the card header is a React toggle and the wrapper editor mounts
// only after `GET /api/admin/email` resolves — so each test starts from the hydrated shell WITH
// that response in, addresses the card by its stable `data-last-card="email"` id (the header's
// accessible name also carries the status pill's text, which varies with the stack), and pairs
// the Save click with its PUT.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { NAV_TIMEOUT, clickAndAwait, gotoLoaded, gotoReady } from "./helpers/ready";

test.describe("profile email-notifications toggle (§12)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/profile");
    await expect(page.getByRole("heading", { name: "Email notifications" })).toBeVisible();
  });

  test("defaults to On and persists an Off choice across reloads", async ({ page }) => {
    const group = () => page.getByRole("group", { name: "Email notifications" });
    const on = () => group().getByRole("button", { name: /^On/ });
    const off = () => group().getByRole("button", { name: /^Off/ });
    await expect(on()).toHaveAttribute("aria-pressed", "true"); // default ON (migration default)

    await clickAndAwait(page, () => off().click(), "/api/me", { method: "PATCH" });
    await expect(off()).toHaveAttribute("aria-pressed", "true");
    await gotoReady(page, "/profile");
    await expect(off()).toHaveAttribute("aria-pressed", "true");

    // Restore the default so the test is idempotent for the next run.
    await clickAndAwait(page, () => on().click(), "/api/me", { method: "PATCH" });
    await expect(on()).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("administration Email notifications card (§12)", () => {
  // The card's always-visible header button, addressed by the card's id rather than by its
  // accessible name (title + live status pill).
  const header = (page: Page) => page.locator('[data-last-card="email"] [data-card-header]');

  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/admin", "/api/admin/email");
    await expect(header(page)).toBeVisible();
  });

  test("collapsed by default; expanding reveals the connect control and wrapper editor", async ({ page }) => {
    const h = header(page);
    await expect(h).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("heading", { name: "Message wrapper" })).toHaveCount(0);

    await h.click();
    await expect(h).toHaveAttribute("aria-expanded", "true");
    // Connect control renders as a link (key configured) or a disabled button (key missing).
    await expect(page.getByText(/set email service account|re-connect/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Message wrapper" })).toBeVisible();
  });

  test("wrapper save enforces exactly one [SYSTEM MESSAGE] placeholder", async ({ page }) => {
    await header(page).click();
    await expect(header(page)).toHaveAttribute("aria-expanded", "true");
    // WrapperEditor is a next/dynamic chunk fetched on first expand (EmailCard.tsx) - under
    // `next dev` its first appearance includes a client-chunk compile no warm-up can reach.
    const editor = page.locator(".wrapper-editor .ProseMirror");
    await expect(editor).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(editor).toHaveAttribute("contenteditable", "true"); // TipTap is mounted and live
    const save = page.getByRole("button", { name: "Save wrapper" });

    // No placeholder → save disabled with the inline hint.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Hello team,");
    await expect(save).toBeDisabled();
    await expect(page.getByText(/add the \[SYSTEM MESSAGE\] placeholder/i)).toBeVisible();

    // Insert the placeholder via the toolbar → save enables; saving reports success.
    await page.getByRole("button", { name: /insert \[SYSTEM MESSAGE\]/i }).click();
    await expect(save).toBeEnabled();
    await clickAndAwait(page, () => save.click(), "/api/admin/email/wrapper", { method: "PUT" });
    await expect(page.getByText("Message wrapper saved.")).toBeVisible();
  });
});
