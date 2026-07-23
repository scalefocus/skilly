// e2e: the universal clear (✕) affordance on the app-shell top-bar search (SKILLY_SPEC.md §10).
// The right slot toggles between the CTRL+K hint (empty box) and a ✕ button (box holds text); the
// ✕ and the Escape key both clear the box in one action, keep focus, and — on a live-filter page —
// drop ?q= immediately so the full list snaps back. Runs against the dev stack (SKILLY_DEV_AUTH=1)
// using the seeded catalog; opt-in, not part of the default `pnpm -r test`. Read-only.
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as the other
// dev-stack specs. page.request shares the page cookie jar, so the next navigation is authed.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", { form: { csrfToken: csrf.csrfToken, json: "true" } });
  expect(res.ok()).toBeTruthy();
}

// The top-bar box (registry aria-label), the CTRL+K hint, and the clear button.
const searchBox = (page: Page) => page.getByRole("textbox", { name: "Search skills" });
const kbdHint = (page: Page) => page.locator(".search kbd");
const clearBtn = (page: Page) => page.getByRole("button", { name: "Clear search" });

test.describe("header search clear (✕) affordance (§10)", () => {
  test("live-filter page: ✕ replaces CTRL+K, clears the box, and drops ?q= instantly", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/catalog");

    const box = searchBox(page);
    // First navigation on a dev server pays the on-demand route compile — allow generous time.
    await expect(box).toBeVisible({ timeout: 20_000 });

    // Empty box → CTRL+K hint shown, no ✕.
    await expect(kbdHint(page)).toBeVisible();
    await expect(clearBtn(page)).toHaveCount(0);

    // Typing shows the ✕ and hides the hint, and live-filters into ?q=.
    await box.fill("pdf");
    await expect(clearBtn(page)).toBeVisible();
    await expect(kbdHint(page)).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]q=pdf\b/, { timeout: 10_000 });

    // Clicking ✕ empties the box, drops ?q= at once, and flips the slot back to CTRL+K. Focus stays.
    await clearBtn(page).click();
    await expect(box).toHaveValue("");
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(kbdHint(page)).toBeVisible();
    await expect(clearBtn(page)).toHaveCount(0);
    await expect(box).toBeFocused();
  });

  test("live-filter page: a shared ?q= link shows the ✕ on arrival; Escape clears it", async ({ page }) => {
    await devSignIn(page);
    // Seeded from ?q= on arrival → the box is non-empty, so the ✕ (not the hint) shows on load.
    await page.goto("/catalog?q=pdf");

    const box = searchBox(page);
    await expect(box).toHaveValue("pdf", { timeout: 20_000 });
    await expect(clearBtn(page)).toBeVisible();
    await expect(kbdHint(page)).toHaveCount(0);

    // Escape clears in one press: box empty, ?q= gone, hint restored.
    await box.press("Escape");
    await expect(box).toHaveValue("");
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(kbdHint(page)).toBeVisible();
    await expect(clearBtn(page)).toHaveCount(0);
  });

  test("typeahead page: the ✕/Escape clear the box and close the suggestion dropdown", async ({ page }) => {
    await devSignIn(page);
    // /whats-new is a non-live-filter page, so the box is the registry typeahead here.
    await page.goto("/whats-new");

    const box = searchBox(page);
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(kbdHint(page)).toBeVisible();

    // Type enough to open the typeahead dropdown, then clear via ✕ → box empty, dropdown gone.
    await box.fill("pdf");
    await expect(clearBtn(page)).toBeVisible();
    await clearBtn(page).click();
    await expect(box).toHaveValue("");
    await expect(page.getByText(/See all results in catalog/i)).toHaveCount(0);
    await expect(kbdHint(page)).toBeVisible();

    // Escape does the same from the keyboard.
    await box.fill("lint");
    await expect(clearBtn(page)).toBeVisible();
    await box.press("Escape");
    await expect(box).toHaveValue("");
    await expect(page.getByText(/See all results in catalog/i)).toHaveCount(0);
    await expect(kbdHint(page)).toBeVisible();
    // A typeahead page never jumps to the catalog on clear — still on /whats-new.
    await expect(page).toHaveURL(/\/whats-new(\?|$)/);
  });
});
