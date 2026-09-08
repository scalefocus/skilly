// e2e: the on/off switches for namespace settings (SKILLY_SPEC.md §30.6) — "Require review for
// submissions" and the Claude plugin marketplace on /namespaces, and their twins on the
// Administration → Namespaces card.
//
// Covers: the control is a real `role=switch` whose aria-checked mirrors the stored value; `global`
// renders on + disabled; switching review OFF asks first (cancel keeps it on, accept persists);
// switching ON saves with no prompt; the label click toggles; both surfaces render the same control.
//
// Self-cleaning: team-a's review policy is restored to what it was on entry.
import { test, expect, devSignIn, type Page } from "./fixtures";

const REVIEW = "Require review for submissions";
const NS = "team-a"; // seeded by db/seed.dev.sql alongside `global`

interface NsRow { id: string; slug: string; requireReview: boolean }

async function administered(page: Page): Promise<NsRow[]> {
  return (await (await page.request.get("/api/namespaces/administered")).json()).namespaces;
}
async function storedReview(page: Page, id: string): Promise<boolean> {
  const j = await (await page.request.get(`/api/namespaces/${id}/settings`)).json();
  return j.namespace.requireReview as boolean;
}
// One namespace's card on /namespaces: the `.row` whose header carries its @slug.
const nsCard = (page: Page, slug: string) => page.locator("div.row").filter({ hasText: `@${slug}` }).first();

test.describe.serial("namespace setting switches (§30.6)", () => {
  test("renders as role=switch mirroring the stored value; global is on and locked", async ({ page }) => {
    await devSignIn(page);
    const rows = await administered(page);
    const team = rows.find((r) => r.slug === NS);
    expect(team, `seed namespace @${NS} missing`).toBeTruthy();

    await page.goto("/namespaces");
    const teamSwitch = nsCard(page, NS).getByRole("switch", { name: REVIEW });
    await expect(teamSwitch).toBeVisible({ timeout: 20_000 });
    await expect(teamSwitch).toHaveAttribute("aria-checked", String(team!.requireReview));
    await expect(teamSwitch).toBeEnabled();
    // The marketplace control on the same card is the same kind of switch.
    await expect(nsCard(page, NS).getByRole("switch", { name: "Claude plugin marketplace" })).toBeVisible();

    // `global` always requires review: the switch shows ON but cannot be flipped.
    const globalSwitch = nsCard(page, "global").getByRole("switch", { name: REVIEW });
    await expect(globalSwitch).toHaveAttribute("aria-checked", "true");
    await expect(globalSwitch).toBeDisabled();
    await expect(nsCard(page, "global").getByText(/always requires review/i)).toBeVisible();
  });

  test("switching review off asks first; cancel keeps it on, accept persists; on saves silently", async ({ page }) => {
    await devSignIn(page);
    const team = (await administered(page)).find((r) => r.slug === NS)!;
    const before = team.requireReview;
    try {
      // Start from ON so the off-path is what we exercise.
      await page.request.patch(`/api/namespaces/${team.id}/settings`, { data: { requireReview: true } });
      await page.goto("/namespaces");
      const sw = nsCard(page, NS).getByRole("switch", { name: REVIEW });
      await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });

      // 1. Cancel the confirm → nothing changes, on screen or in the DB.
      let message = "";
      page.once("dialog", (d) => { message = d.message(); void d.dismiss(); });
      await sw.click();
      expect(message).toContain(`Turn off review for @${NS}`);
      expect(message).toMatch(/publish .* directly/);
      await expect(sw).toHaveAttribute("aria-checked", "true");
      expect(await storedReview(page, team.id)).toBe(true);

      // 2. Accept → persisted, switch shows the server-confirmed OFF.
      page.once("dialog", (d) => void d.accept());
      await sw.click();
      await expect(nsCard(page, NS).getByText("Review policy saved.")).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => storedReview(page, team.id), { timeout: 10_000 }).toBe(false);
      await expect(sw).toHaveAttribute("aria-checked", "false");

      // 3. Back ON: no prompt. (Playwright auto-dismisses an unexpected confirm, which would make
      //    the save NOT happen — so the poll below also proves no dialog was shown.)
      await sw.click();
      await expect.poll(() => storedReview(page, team.id), { timeout: 10_000 }).toBe(true);
      await expect(sw).toHaveAttribute("aria-checked", "true");

      // 4. Clicking the label text toggles too (the <label> wraps the button). Off again → confirm.
      page.once("dialog", (d) => void d.accept());
      await nsCard(page, NS).getByText(REVIEW, { exact: true }).click();
      await expect.poll(() => storedReview(page, team.id), { timeout: 10_000 }).toBe(false);

      // 5. The stored value survives a reload — the switch is not holding client-only state.
      await page.reload();
      await expect(nsCard(page, NS).getByRole("switch", { name: REVIEW })).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    } finally {
      await page.request.patch(`/api/namespaces/${team.id}/settings`, { data: { requireReview: before } });
    }
  });

  test("the Administration → Namespaces card uses the same switches", async ({ page }) => {
    await devSignIn(page);
    const team = (await administered(page)).find((r) => r.slug === NS)!;

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible({ timeout: 20_000 });
    const header = page.getByRole("button", { name: /^Namespaces/ });
    if ((await header.getAttribute("aria-expanded")) === "false") await header.click();

    // The collapsible Namespaces card is itself a section.card that contains every row, so the
    // LAST match is the per-namespace card (innermost in DOM order).
    const adminCard = (slug: string) => page.locator("section.card").filter({ hasText: `@${slug}` }).last();
    const review = adminCard(NS).getByRole("switch", { name: "Require review" });
    await expect(review).toBeVisible({ timeout: 20_000 });
    await expect(review).toHaveAttribute("aria-checked", String(team.requireReview));
    await expect(adminCard(NS).getByRole("switch", { name: "Marketplace" })).toBeVisible();

    const globalReview = adminCard("global").getByRole("switch", { name: "Require review" });
    await expect(globalReview).toHaveAttribute("aria-checked", "true");
    await expect(globalReview).toBeDisabled();
  });
});
