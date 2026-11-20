// e2e: the on/off switches for namespace settings (SKILLY_SPEC.md §30.6) — "Require review" and
// "Marketplace" on the Administration → Namespaces card. The e2e user is a platform admin, and a
// platform admin has no Namespace administration page (§75); the card renders the same shared
// `Switch` with the same confirm-on-off as the namespace admins' page.
//
// Covers: the control is a real `role=switch` whose aria-checked mirrors the stored value; `global`
// renders on + disabled; switching review OFF asks first (cancel keeps it on, accept persists);
// switching ON saves with no prompt; the label click toggles; the value survives a reload.
//
// Self-cleaning: team-a's review policy is restored to what it was on entry.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { reloadReady } from "./helpers/ready";
import { adminNamespaceCard, expandNamespacesCard, openAdminNamespace } from "./helpers/adminNamespaces";

const REVIEW = "Require review";
const NS = "team-a"; // seeded by db/seed.dev.sql alongside `global`

interface NsRow { id: string; slug: string; requireReview: boolean }

async function administered(page: Page): Promise<NsRow[]> {
  return (await (await page.request.get("/api/namespaces/administered")).json()).namespaces;
}
async function storedReview(page: Page, id: string): Promise<boolean> {
  const j = await (await page.request.get(`/api/namespaces/${id}/settings`)).json();
  return j.namespace.requireReview as boolean;
}

test.describe.serial("namespace setting switches (§30.6)", () => {
  test("renders as role=switch mirroring the stored value; global is on and locked", async ({ page }) => {
    await devSignIn(page);
    const rows = await administered(page);
    const team = rows.find((r) => r.slug === NS);
    expect(team, `seed namespace @${NS} missing`).toBeTruthy();

    const card = await openAdminNamespace(page, NS);
    const teamSwitch = card.getByRole("switch", { name: REVIEW });
    await expect(teamSwitch).toBeVisible({ timeout: 20_000 });
    await expect(teamSwitch).toHaveAttribute("aria-checked", String(team!.requireReview));
    await expect(teamSwitch).toBeEnabled();
    // The marketplace control on the same card is the same kind of switch.
    await expect(card.getByRole("switch", { name: "Marketplace" })).toBeVisible();

    // `global` always requires review: the switch shows ON but cannot be flipped, and it has no
    // Delete button (§72.5).
    const globalCard = await openAdminNamespace(page, "global");
    const globalSwitch = globalCard.getByRole("switch", { name: REVIEW });
    await expect(globalSwitch).toHaveAttribute("aria-checked", "true");
    await expect(globalSwitch).toBeDisabled();
    await expect(globalCard.getByTestId("ns-delete-global")).toHaveCount(0);
  });

  test("switching review off asks first; cancel keeps it on, accept persists; on saves silently", async ({ page }) => {
    await devSignIn(page);
    const team = (await administered(page)).find((r) => r.slug === NS)!;
    const before = team.requireReview;
    try {
      // Start from ON so the off-path is what we exercise.
      await page.request.patch(`/api/namespaces/${team.id}/settings`, { data: { requireReview: true } });
      const card = await openAdminNamespace(page, NS);
      const sw = card.getByRole("switch", { name: REVIEW });
      await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
      await expect(card.getByText("moderated", { exact: true })).toBeVisible();

      // 1. Cancel the confirm → nothing changes, on screen or in the DB.
      let message = "";
      page.once("dialog", (d) => { message = d.message(); void d.dismiss(); });
      await sw.click();
      expect(message).toContain(`Turn off review for @${NS}`);
      expect(message).toMatch(/publish .* directly/);
      await expect(sw).toHaveAttribute("aria-checked", "true");
      expect(await storedReview(page, team.id)).toBe(true);

      // 2. Accept → persisted, switch shows the server-confirmed OFF and the pill follows it.
      page.once("dialog", (d) => void d.accept());
      await sw.click();
      await expect.poll(() => storedReview(page, team.id), { timeout: 10_000 }).toBe(false);
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await expect(card.getByText("direct publish", { exact: true })).toBeVisible();

      // 3. Back ON: no prompt. (Playwright auto-dismisses an unexpected confirm, which would make
      //    the save NOT happen — so the poll below also proves no dialog was shown.)
      await sw.click();
      await expect.poll(() => storedReview(page, team.id), { timeout: 10_000 }).toBe(true);
      await expect(sw).toHaveAttribute("aria-checked", "true");

      // 4. Clicking the label text toggles too (the <label> wraps the button). Off again → confirm.
      page.once("dialog", (d) => void d.accept());
      await card.getByText(REVIEW, { exact: true }).click();
      await expect.poll(() => storedReview(page, team.id), { timeout: 10_000 }).toBe(false);

      // 5. The stored value survives a reload — the switch is not holding client-only state. (The
      //    reload drops the search; team-a is on the first page of the list.)
      await reloadReady(page);
      await expandNamespacesCard(page);
      await expect(adminNamespaceCard(page, NS).getByRole("switch", { name: REVIEW })).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    } finally {
      await page.request.patch(`/api/namespaces/${team.id}/settings`, { data: { requireReview: before } });
    }
  });
});
