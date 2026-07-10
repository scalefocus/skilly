// e2e: the §12 email-notifications surfaces — the per-user profile toggle (default ON,
// persisted via PATCH /api/me) and the Administration "Email notifications" card (collapsed
// by default; status pill; wrapper editor enforcing the single [SYSTEM MESSAGE] placeholder
// before Save enables). Runs against the dev stack (SKILLY_DEV_AUTH=1, dev user is a
// platform admin); opt-in, not part of the default `pnpm -r test`.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback — same handshake as e2e/shots.mjs.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("profile email-notifications toggle (§12)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "Email notifications" })).toBeVisible();
  });

  test("defaults to On and persists an Off choice across reloads", async ({ page }) => {
    const group = page.getByRole("group", { name: "Email notifications" });
    const on = group.getByRole("button", { name: /^On/ });
    const off = group.getByRole("button", { name: /^Off/ });
    await expect(on).toHaveAttribute("aria-pressed", "true"); // default ON (migration default)

    await off.click();
    await expect(off).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByRole("group", { name: "Email notifications" }).getByRole("button", { name: /^Off/ })).toHaveAttribute("aria-pressed", "true");

    // Restore the default so the test is idempotent for the next run.
    await page.getByRole("group", { name: "Email notifications" }).getByRole("button", { name: /^On/ }).click();
    await expect(page.getByRole("group", { name: "Email notifications" }).getByRole("button", { name: /^On/ })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("administration Email notifications card (§12)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    await expect(page.getByRole("button", { name: /email notifications/i })).toBeVisible();
  });

  test("collapsed by default; expanding reveals the connect control and wrapper editor", async ({ page }) => {
    const header = page.getByRole("button", { name: /email notifications/i });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Message wrapper", { exact: true })).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    // Connect control renders as a link (key configured) or a disabled button (key missing).
    await expect(page.getByText(/set email service account|re-connect/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Message wrapper" })).toBeVisible();
  });

  test("wrapper save enforces exactly one [SYSTEM MESSAGE] placeholder", async ({ page }) => {
    await page.getByRole("button", { name: /email notifications/i }).click();
    const editor = page.locator(".wrapper-editor .ProseMirror");
    await expect(editor).toBeVisible();
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
    await save.click();
    await expect(page.getByText("Message wrapper saved.")).toBeVisible();
  });
});
