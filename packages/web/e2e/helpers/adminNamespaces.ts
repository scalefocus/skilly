// The Administration → Namespaces card, for specs that drive one namespace's settings there
// (SKILLY_SPEC.md §30.6, §75.4). Every e2e user is a platform admin, and a platform admin has no
// Namespace administration page (§75): the card is where they set a namespace's review policy and
// target, maintainer contact, marketplace and policy rules.
import { expect, type Locator, type Page } from "@playwright/test";
import { awaitApi, gotoLoaded } from "./ready";

/** One namespace's block inside the Namespaces card. */
export const adminNamespaceCard = (page: Page, slug: string): Locator => page.locator(`[data-ns-card="${slug}"]`);

/** Expand the Namespaces card if it is collapsed (cards start collapsed; the choice persists). */
export async function expandNamespacesCard(page: Page): Promise<void> {
  const header = page.getByRole("button", { name: /^Namespaces/ }).first();
  await expect(header).toBeVisible({ timeout: 20_000 });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

/**
 * Open `/admin`, expand the Namespaces card and narrow its list to `slug` (the list is paginated,
 * so the search is what guarantees the row is there). Returns that namespace's block.
 */
export async function openAdminNamespace(page: Page, slug: string): Promise<Locator> {
  await gotoLoaded(page, "/admin", "/api/admin/namespaces");
  await expandNamespacesCard(page);
  const search = page.getByRole("textbox", { name: "Search namespaces" });
  await expect(search).toBeVisible({ timeout: 20_000 });
  await Promise.all([awaitApi(page, /\/api\/admin\/namespaces\?.*q=/), search.fill(slug)]);
  const card = adminNamespaceCard(page, slug);
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}
