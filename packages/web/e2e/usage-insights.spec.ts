// e2e: Usage insights (SKILLY_SPEC.md §68.4, §68.7, §68.8). With the platform switch on, generating
// a marketplace add command with "Share usage" ticked shows the one-time key block; My marketplaces
// shows the Usage sharing card and Stop sharing turns it back to Not sharing; /usage carries the
// uses column; with the switch off, none of it shows. The dev user is a platform admin.
//
// EXCLUSIVE in groups.ts: it flips a platform setting every other spec's /usage and panels read, and
// it mints (then deletes) the dev user's usage key. Everything it changes is restored.
import { test, expect, devSignIn } from "./fixtures";

interface NsRow { id: string; slug: string; marketplaceEnabled: boolean }

test.describe.serial("usage insights (§68)", () => {
  test("share usage at mint, the Usage sharing card, the uses column, and the switch", async ({ page }) => {
    await devSignIn(page);
    const settings = await (await page.request.get("/api/admin/settings")).json();
    const wasOn = settings.usageInsightsEnabled === true;
    const list = await (await page.request.get("/api/namespaces/administered")).json();
    const ns: NsRow = list.namespaces.find((n: NsRow) => n.slug === "team-a") ?? list.namespaces[0];
    const wasEnabled = ns.marketplaceEnabled;
    // Start from "not sharing", whatever an earlier run left.
    await page.request.delete("/api/me/usage-key");
    try {
      const on = await page.request.patch("/api/admin/settings", { data: { usageInsightsEnabled: true } });
      expect(on.ok(), await on.text()).toBeTruthy();
      if (!wasEnabled) {
        const r = await page.request.patch(`/api/namespaces/${ns.id}/settings`, { data: { marketplaceEnabled: true } });
        expect(r.ok(), await r.text()).toBeTruthy();
      }

      // The add panel: tick Share usage, generate → the add command AND the key block (once).
      await page.goto("/catalog/marketplaces");
      await expect(page.getByRole("heading", { name: "Marketplaces." })).toBeVisible({ timeout: 20_000 });
      const row = page.locator(".mk-row", { hasText: ns.slug === "team-a" ? "Team A" : ns.slug }).first();
      await row.getByRole("button", { name: /^(Install|Add again)$/ }).click();
      const tick = row.getByTestId("share-usage").getByRole("checkbox");
      await expect(tick).toBeVisible();
      await expect(tick).not.toBeChecked();
      await tick.check();
      await row.getByRole("button", { name: "Generate add command" }).click();
      const block = row.getByTestId("usage-key-block");
      await expect(block).toBeVisible({ timeout: 15_000 });
      await expect(block.locator("pre")).toContainText('"SKILLY_USAGE_KEY"');
      await expect(block).toContainText("Shown once");

      // My marketplaces: Sharing since …, then Stop sharing → Not sharing.
      await page.goto("/marketplaces");
      const card = page.getByTestId("usage-sharing-card");
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText("Sharing");
      await expect(card).toContainText("no reports yet");
      page.once("dialog", (d) => void d.accept());
      await card.getByRole("button", { name: "Stop sharing" }).click();
      await expect(card).toContainText("Not sharing", { timeout: 15_000 });
      await expect(card.getByRole("button", { name: "Share usage" })).toBeVisible();

      // A second key holder sees the "already share" line instead of the tick.
      await card.getByRole("button", { name: "Share usage" }).click();
      await expect(card.getByTestId("usage-key-block")).toBeVisible({ timeout: 15_000 });
      await page.goto("/catalog/marketplaces");
      await expect(page.getByRole("heading", { name: "Marketplaces." })).toBeVisible({ timeout: 20_000 });
      const row2 = page.locator(".mk-row", { hasText: ns.slug === "team-a" ? "Team A" : ns.slug }).first();
      await row2.getByRole("button", { name: /^(Install|Add again)$/ }).click();
      await expect(row2.getByTestId("share-usage-held")).toBeVisible();
      await expect(row2.getByTestId("share-usage")).toHaveCount(0);

      // /usage: the uses footnote and the Uses sort appear while the switch is on.
      await page.goto("/usage");
      await expect(page.getByRole("heading", { name: "Usage." })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("uses-footnote").first()).toBeVisible();
      await expect(page.getByRole("group", { name: "Sort by" }).getByRole("button", { name: "Uses" })).toBeVisible();

      // The Administration card reads "on".
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Usage insights" })).toBeVisible({ timeout: 20_000 });

      // Off: nothing shows.
      const off = await page.request.patch("/api/admin/settings", { data: { usageInsightsEnabled: false } });
      expect(off.ok()).toBeTruthy();
      await page.goto("/usage");
      await expect(page.getByRole("heading", { name: "Usage." })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("uses-footnote")).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Sort by" }).getByRole("button", { name: "Uses" })).toHaveCount(0);
      await page.goto("/marketplaces");
      await expect(page.getByRole("heading", { name: "Added marketplaces." })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("usage-sharing-card")).toHaveCount(0);
    } finally {
      await page.request.delete("/api/me/usage-key");
      await page.request.patch("/api/admin/settings", { data: { usageInsightsEnabled: wasOn } });
      if (!wasEnabled) await page.request.patch(`/api/namespaces/${ns.id}/settings`, { data: { marketplaceEnabled: false } });
    }
  });
});
