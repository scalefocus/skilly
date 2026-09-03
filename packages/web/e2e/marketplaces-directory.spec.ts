// e2e: the Marketplaces directory page (SKILLY_SPEC.md §30.6, Page 3) and the catalog namespace
// view it links to (§10). The dev user is a platform admin, so every namespace is in their row set;
// we switch a namespace's marketplace ON for the test (restoring it after), then assert the row,
// its payload-count wording, the Skills link, the inline Install panel minting a command, the
// fallback disclosure, and that the sidebar lights up the Marketplaces item (not Catalog).
//
// The mint creates a real token in the ephemeral CI DB; disabling the marketplace afterwards
// revokes it, so the test leaves nothing behind when the marketplace started out disabled.
import { test, expect, devSignIn } from "./fixtures";

interface NsRow { id: string; slug: string; displayName: string; marketplaceEnabled: boolean }

test.describe.serial("marketplaces directory (§30.6 Page 3)", () => {
  test("lists an enabled namespace marketplace, mints from the inline panel, links to its skills", async ({ page }) => {
    await devSignIn(page);
    const list = await (await page.request.get("/api/namespaces/administered")).json();
    const ns: NsRow = list.namespaces.find((n: NsRow) => n.slug === "team-a") ?? list.namespaces[0];
    const wasEnabled = ns.marketplaceEnabled;
    if (!wasEnabled) {
      const r = await page.request.patch(`/api/namespaces/${ns.id}/settings`, { data: { marketplaceEnabled: true } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }
    try {
      await page.goto("/catalog/marketplaces");
      await expect(page.getByRole("heading", { name: "Marketplaces." })).toBeVisible({ timeout: 20_000 });

      // The directory endpoint returns the row (the dev admin may mint for every namespace).
      const dir = await (await page.request.get("/api/marketplaces/directory")).json();
      const apiRow = dir.rows.find((r: { namespaceSlug: string | null }) => r.namespaceSlug === ns.slug);
      expect(apiRow, "enabled namespace marketplace is in the directory").toBeTruthy();
      expect(["none", "user", "email"]).toContain(apiRow.contact.kind);

      const row = page.locator(".mk-row", { hasText: ns.displayName }).first();
      await expect(row).toBeVisible();
      // The count carries its verb: it is the marketplace payload, not the catalog size (§30.6).
      await expect(row.getByText(/publishes \d+ skills?/)).toBeVisible();
      await expect(row.getByText(/synced|not synced yet/)).toBeVisible();
      // "Skills" opens the catalog's namespace view for this namespace (§10).
      await expect(row.getByRole("link", { name: "Skills" })).toHaveAttribute("href", new RegExp(`^/catalog\\?ns=${ns.slug}&nsName=`));
      // Reach out is always rendered — as a DM button, a mailto link, or disabled (three states).
      await expect(row.getByRole("button", { name: "Reach out" }).or(row.getByRole("link", { name: "Reach out" }))).toHaveCount(1);

      // The sidebar lights up Marketplaces, not Catalog (exact-match rule for /catalog).
      const active = page.locator("aside .nav-item.active, nav .nav-item.active, .nav-item.active");
      await expect(active).toHaveCount(1);
      await expect(active).toHaveText(/Marketplaces/);

      // Inline Install: expiry picker + Generate, then the command and the fallback disclosure.
      await row.getByRole("button", { name: /^(Install|Add again)$/ }).click();
      await expect(row.getByRole("group", { name: "Install expiry" })).toBeVisible();
      await row.getByRole("button", { name: "Generate add command" }).click();
      await expect(row.getByText(/\/plugin marketplace add https:\/\//).first()).toBeVisible({ timeout: 15_000 });
      await expect(row.getByText("If background updates fail")).toBeVisible();
      // The fallback is collapsed until opened.
      await expect(row.getByText(/git config --global/)).toBeHidden();
      await row.getByText("If background updates fail").click();
      await expect(row.getByText(/git config --global/)).toBeVisible();
    } finally {
      if (!wasEnabled) await page.request.patch(`/api/namespaces/${ns.id}/settings`, { data: { marketplaceEnabled: false } });
    }
  });

  test("the catalog namespace view shows its banner and clears back to the full catalog", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/catalog?ns=team-a&nsName=Team%20A");
    const banner = page.locator(".ns-view-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("Skills in Team A");
    await banner.getByRole("link", { name: /clear/ }).click();
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.locator(".ns-view-banner")).toHaveCount(0);
  });
});
