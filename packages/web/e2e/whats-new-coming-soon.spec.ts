// e2e: the What's new page's "Coming soon" section (SKILLY_SPEC.md §23 "Coming soon", §60.3). Every
// item is a published feature idea, so the expectation is the server's own list (`GET
// /api/coming-soon`). The signed-in user is a platform admin, who may always suggest, so the section
// always shows: collapsed with "Coming soon · N", expands to exactly N rows, collapsed again after a
// reload.
import { authedTest as test, expect } from "./fixtures";
import { gotoReady, reloadReady } from "./helpers/ready";

test("What's new: Coming soon lists the published items, collapsed by default and never remembered", async ({ page }) => {
  const live = await page.request.get("/api/coming-soon");
  expect(live.ok()).toBeTruthy();
  const body = (await live.json()) as { items: { title: string }[]; canSuggest: boolean };
  expect(body.canSuggest).toBe(true);
  const expected = body.items.map((i) => i.title);

  const listed = page.waitForResponse((r) => r.url().endsWith("/api/coming-soon"));
  await gotoReady(page, "/whats-new");
  await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible();
  await listed;
  const section = page.getByTestId("coming-soon");

  const head = section.getByRole("button", { name: new RegExp(`^Coming soon · ${expected.length}`) });
  await expect(head).toBeVisible();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("list", { name: "Coming soon" })).toHaveCount(0);

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  if (expected.length > 0) {
    const list = section.getByRole("list", { name: "Coming soon" });
    await expect(list.getByRole("listitem")).toHaveCount(expected.length);
    await expect(list.getByRole("listitem").first()).toContainText(expected[0]!);
  }

  await reloadReady(page);
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("list", { name: "Coming soon" })).toHaveCount(0);
});
