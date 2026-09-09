// e2e: the Quick start page's "Two more ways to connect your agent" step (SKILLY_SPEC.md §23) —
// the step renders in position 4 with its two same-tab in-app buttons, which actually land on the
// Marketplaces directory and the MCP page; the closing card carries the same two links.
import { authedTest as test, expect } from "./fixtures";

test.describe("Quick start — connect step (§23)", () => {
  test("step 4 renders between Install and Manage with both in-app links", async ({ page }) => {
    await page.goto("/quick-start", { waitUntil: "domcontentloaded" });
    const headings = page.locator("main section h2");
    await expect(headings.filter({ hasText: "Two more ways to connect your agent" })).toBeVisible({ timeout: 25_000 });
    const titles = await headings.allTextContents();
    const i = titles.indexOf("Two more ways to connect your agent");
    expect(titles[i - 1]).toBe("Install it into your agent");
    expect(titles[i + 1]).toBe("Manage what you've installed");

    const card = page.locator("main section", { hasText: "Two more ways to connect your agent" });
    const mkt = card.getByRole("link", { name: /^Marketplaces/ });
    const mcp = card.getByRole("link", { name: /^MCP server/ });
    await expect(mkt).toHaveAttribute("href", "/catalog/marketplaces");
    await expect(mcp).toHaveAttribute("href", "/mcp");
    // Same-tab: internal buttons never carry the external new-tab target.
    await expect(mkt).not.toHaveAttribute("target", "_blank");
    await expect(mcp).not.toHaveAttribute("target", "_blank");
    await expect(card.locator("img")).toHaveAttribute("src", "/quickstart/connect.png");
  });

  test("the closing card links to Marketplaces and MCP server", async ({ page }) => {
    await page.goto("/quick-start", { waitUntil: "domcontentloaded" });
    const cta = page.locator(".qs-cta");
    await expect(cta.getByRole("link", { name: "Marketplaces" })).toHaveAttribute("href", "/catalog/marketplaces", { timeout: 25_000 });
    await expect(cta.getByRole("link", { name: "MCP server" })).toHaveAttribute("href", "/mcp");
  });

  test("the Marketplaces button lands on the directory", async ({ page }) => {
    await page.goto("/quick-start", { waitUntil: "domcontentloaded" });
    // Wait for the shell to hydrate before clicking: a click that races a dev-server recompile /
    // hydration can be swallowed, and the assertion below would then time out on the old URL.
    await expect(page.locator(".colophon-version")).toBeVisible({ timeout: 25_000 });
    const card = page.locator("main section", { hasText: "Two more ways to connect your agent" });
    await card.getByRole("link", { name: /^Marketplaces/ }).click({ timeout: 25_000 });
    // Generous: the first hit on /catalog/marketplaces pays the `next dev` on-demand compile.
    await expect(page).toHaveURL(/\/catalog\/marketplaces$/, { timeout: 25_000 });
    await expect(page.locator(".colophon-version")).toBeVisible({ timeout: 25_000 });
  });
});
