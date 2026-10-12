// e2e: the What's new page's "Coming soon" section (SKILLY_SPEC.md §23 "Coming soon"). The
// expectation is derived from UPCOMING filtered for the dev user's own roles (read from /api/me),
// so the spec holds whether the list is empty (as at launch — the section must be absent) or not
// (collapsed with "Coming soon · N", expands to exactly N rows, collapsed again after a reload).
import { UPCOMING, upcomingFor } from "../src/app/whats-new/upcoming";
import { authedTest as test, expect } from "./fixtures";
import { gotoReady, reloadReady } from "./helpers/ready";

test("What's new: Coming soon is audience-filtered, collapsed by default and never remembered", async ({ page }) => {
  const me = (await (await page.request.get("/api/me")).json()) as { isPlatformAdmin?: boolean; administersNamespace?: boolean };
  const expected = upcomingFor(UPCOMING, { isPlatformAdmin: !!me.isPlatformAdmin, administersNamespace: !!me.administersNamespace });

  // The section renders only once the page's /api/me read resolves, and the page's read-receipt
  // stamp is sent right after that — so the stamp's response means the section has had its chance.
  const stamped = page.waitForResponse((r) => r.url().includes("/api/me/whats-new-seen"));
  await gotoReady(page, "/whats-new");
  await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible();
  await stamped;
  const section = page.getByTestId("coming-soon");

  if (expected.length === 0) {
    await expect(section).toHaveCount(0);
    return;
  }

  const head = section.getByRole("button", { name: new RegExp(`^Coming soon · ${expected.length}`) });
  await expect(head).toBeVisible();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("list", { name: "Coming soon" })).toHaveCount(0);

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const list = section.getByRole("list", { name: "Coming soon" });
  await expect(list.getByRole("listitem")).toHaveCount(expected.length);
  await expect(list.getByRole("listitem").first()).toContainText(expected[0]!.title);

  await reloadReady(page);
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("list", { name: "Coming soon" })).toHaveCount(0);
});
