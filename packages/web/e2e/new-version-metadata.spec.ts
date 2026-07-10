// e2e: propose-a-new-version metadata editing + "Keep current files" (SKILLY_SPEC.md §8).
// A re-version may now change the Title, description, categories, tags, and tool/harness — only
// the slug (and visibility) stay locked — and the source is optional: "Keep current files" (the
// default when a stable version exists) reuses the latest stable artifact byte-for-byte, gated by
// the no-op guard (at least one field must differ). Runs against the dev stack
// (SKILLY_DEV_AUTH=1) using the seeded `global/pdf-tools` skill; opt-in, not part of the default
// `pnpm -r test`. Deliberately WRITE-FREE: the no-op guard blocks the unchanged submit client-side,
// so no proposal is ever created in the dev stack.
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

test.describe("new-version proposal: editable metadata + keep current files (@global/pdf-tools)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await page.goto("/propose?ns=global&slug=pdf-tools&newVersion=1");
    // The form hides until the pre-fill loads. Generous timeout: the FIRST navigation on a dev
    // server pays the on-demand route compile (page + API), which can exceed the 5s default.
    await expect(page.getByRole("heading", { name: "Propose a new version." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /keep current files/i })).toBeVisible({ timeout: 20_000 });
  });

  test("keep current files is the default and hides the source panel", async ({ page }) => {
    const keep = page.getByRole("button", { name: /keep current files \(v/i });
    await expect(keep).toHaveAttribute("aria-pressed", "true");
    // No upload dropzone / pointer fields while reusing.
    await expect(page.getByText("Drag & drop your skill bundle here")).toHaveCount(0);
    await expect(page.getByText("External git URL")).toHaveCount(0);
    // Switching to a fresh source reveals the panel again.
    await page.getByRole("button", { name: /upload a new bundle|point at a new ref/i }).click();
    await expect(
      page.getByText("Drag & drop your skill bundle here").or(page.getByText("External git URL")),
    ).toBeVisible();
  });

  test("title, tags, and tool/harness are editable; the slug is locked", async ({ page }) => {
    // Slug stays read-only (the immutable identity).
    await expect(page.getByText("Skill slug · locked")).toBeVisible();
    // Title is an enabled input (§8: a re-version may retitle the skill).
    await expect(page.getByPlaceholder("PDF Tools")).toBeEnabled();
    await expect(page.getByText("Editing the title renames the skill", { exact: false })).toBeVisible();
    // Tags input + harness picker are present and enabled. (The TagInput placeholder only shows
    // when empty — the seeded skill has tags — so assert via the new-version hint text instead.)
    await expect(page.getByText("Pre-filled with the skill's current tags", { exact: false })).toBeVisible();
    await expect(page.getByPlaceholder("Search a tool… (default: Generic)")).toBeEnabled();
  });

  test("the no-op guard blocks an unchanged reuse submit (no proposal created)", async ({ page }) => {
    await page.getByRole("button", { name: "Submit for review →" }).click();
    await expect(page.getByText(/nothing changed — edit at least one field/i)).toBeVisible();
    // Still on the propose form — nothing was created.
    await expect(page).toHaveURL(/\/propose/);
  });
});
