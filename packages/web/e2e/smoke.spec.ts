// UI smoke tests — verify the shell renders and auth gates are present without needing a
// seeded backend. Deeper journeys (propose → review → publish → install) run against the
// dev stack with SKILLY_DEV_AUTH=1; add them here as the suite grows.
import { test, expect } from "@playwright/test";

test("app shell renders with branding and sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("skilly", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in with entra id/i })).toBeVisible();
});

test("catalog requires auth and shows a sign-in prompt", async ({ page }) => {
  await page.goto("/catalog");
  // The catalog fetches /api/skills which 401s when unauthenticated; the UI surfaces a
  // sign-in message rather than skill data.
  await expect(page.getByText(/sign in/i).first()).toBeVisible();
});
