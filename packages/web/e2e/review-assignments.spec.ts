// e2e: review assignments and targets (SKILLY_SPEC.md §65.12).
//
// Covers: a namespace admin sets a 1-day review target on /namespaces; a proposal in that namespace
// shows *Reviewer: Unassigned* and the *Review target* line with its due pill; the proposer is never
// offered *Assign to me* on their own proposal and never appears in the picker; on the queue,
// *Unassigned* keeps the row (with its due pill) and *Assigned to me* drops it.
//
// Self-cleaning: the proposal is deleted and team-a's review target restored. The target is also
// cleared through the API before the UI sets it: Save stays disabled until the field differs from
// the stored value, so a target an earlier attempt left at 1 would block the save.
import { test, expect, devSignIn, signedInDisplayName } from "./fixtures";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";
import { createHostedProposal } from "./helpers/skills";

const NS = "team-a"; // seeded by db/seed.dev.sql

test("§65 review target, reviewer line, picker and queue filters", async ({ page }) => {
  await devSignIn(page);
  const team = ((await (await page.request.get("/api/namespaces/administered")).json()).namespaces as { id: string; slug: string; reviewTargetDays: number | null }[])
    .find((n) => n.slug === NS);
  expect(team, `seed namespace @${NS} missing`).toBeTruthy();
  const before = team!.reviewTargetDays ?? null;
  const slug = `e2e-assign-${Date.now().toString(36)}`;
  let proposalId: string | null = null;
  try {
    // 1. A 1-business-day target, set on the Namespace administration page — from no target, so the
    //    field is dirty and Save enabled whatever an earlier attempt left behind.
    const cleared = await page.request.patch(`/api/namespaces/${team!.id}/settings`, { data: { reviewTargetDays: null } });
    expect(cleared.ok(), await cleared.text()).toBeTruthy();
    await gotoLoaded(page, "/namespaces", "/api/namespaces/administered");
    const card = page.locator("div.row").filter({ hasText: `@${NS}` }).first();
    await card.getByTestId("ns-review-target-input").fill("1");
    await clickAndAwait(page, () => card.getByTestId("ns-review-target-save").click(), `/api/namespaces/${team!.id}/settings`, { method: "PATCH" });
    await expect(card.getByText("Review target saved.")).toBeVisible();
    await expect(card.getByTestId("ns-review-counts")).toContainText("overdue");

    // 2. A proposal in that namespace: unassigned, with a due date.
    proposalId = await createHostedProposal(page, { namespaceSlug: NS, skillSlug: slug });
    await gotoLoaded(page, `/proposals/${proposalId}`, `/api/proposals/${proposalId}`);
    await expect(page.getByTestId("proposal-reviewer-name")).toHaveText("Unassigned");
    await expect(page.getByTestId("proposal-review-target")).toContainText("Review target: 1 business day");
    await expect(page.getByTestId("proposal-review-target").getByTestId("due-pill")).toBeVisible();
    await expect(page.getByTestId("assign-me")).toHaveCount(0); // never on your own proposal

    // The picker lists reviewers, never the proposer.
    await page.getByTestId("assign-open").click();
    const picker = page.getByTestId("assignee-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Loading…")).toHaveCount(0);
    await expect(picker.getByTestId("assignee-option").filter({ hasText: signedInDisplayName() })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    // 3. The queue's assignee filters, and the row's due pill.
    await gotoLoaded(page, "/proposals?tab=review", /\/api\/proposals\?tab=review/);
    await clickAndAwait(page, () => page.getByTestId("filter-assignee-none").click(), /assignee=none/);
    const row = page.locator("a.row").filter({ hasText: slug });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("proposal-row-due")).toBeVisible();
    await expect(row.getByTestId("proposal-row-assignee")).toHaveText("unassigned");
    await clickAndAwait(page, () => page.getByTestId("filter-assignee-me").click(), /assignee=me/);
    await expect(page.locator("a.row").filter({ hasText: slug })).toHaveCount(0);
  } finally {
    if (proposalId) await page.request.delete(`/api/proposals/${proposalId}`);
    await page.request.patch(`/api/namespaces/${team!.id}/settings`, { data: { reviewTargetDays: before } });
  }
});
