// e2e: the What's new page's "Coming soon" section (SKILLY_SPEC.md §23 "Coming soon", §60.3). With
// feature ideas on, the expectation is the server's own merged list (`GET /api/coming-soon` — spec'd
// teasers plus published ideas), and the section always shows. With the feature off (404) it falls
// back to UPCOMING filtered for the dev user's roles, and is absent when that is empty. Either way:
// collapsed with "Coming soon · N", expands to exactly N rows, collapsed again after a reload.
import { UPCOMING, upcomingFor } from "../src/app/whats-new/upcoming";
import { authedTest as test, expect } from "./fixtures";
import { gotoReady, reloadReady } from "./helpers/ready";

test("What's new: Coming soon is audience-filtered, collapsed by default and never remembered", async ({ page }) => {
  const me = (await (await page.request.get("/api/me")).json()) as { isPlatformAdmin?: boolean; administersNamespace?: boolean };
  const live = await page.request.get("/api/coming-soon");
  const expected: string[] = live.ok()
    ? ((await live.json()) as { items: { title: string }[] }).items.map((i) => i.title)
    : upcomingFor(UPCOMING, { isPlatformAdmin: !!me.isPlatformAdmin, administersNamespace: !!me.administersNamespace }).map((e) => e.title);

  // The section renders only once the page's /api/me read resolves, and the page's read-receipt
  // stamp is sent right after that — so the stamp's response means the section has had its chance.
  const stamped = page.waitForResponse((r) => r.url().includes("/api/me/whats-new-seen"));
  const listed = live.ok() ? page.waitForResponse((r) => r.url().endsWith("/api/coming-soon")) : null;
  await gotoReady(page, "/whats-new");
  await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible();
  await stamped;
  await listed;
  const section = page.getByTestId("coming-soon");

  if (expected.length === 0 && !live.ok()) {
    await expect(section).toHaveCount(0);
    return;
  }

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
