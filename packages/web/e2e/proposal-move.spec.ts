// e2e: a reviewer moves a NEW-SKILL proposal to another namespace (SKILLY_SPEC.md §74). Runs against
// the dev stack (SKILLY_DEV_AUTH=1) as the worker's platform-admin user, who reviews every namespace —
// so the move keeps the page open (a namespace admin's hand-off, the members-only list, the refusals
// and Move & accept's rollback need several identities: proposalRetarget.dbtest.ts covers them).
//
// Journey: a restricted `team-a` proposal → ✎ Edit → the Namespace field picks the destination (the
// banner offers move or move-and-accept, the Decision block swaps to Move buttons) → Move → the
// proposal now lives in the destination, back in `proposed`, with a "Moved from" revision and team-a
// on its shared list → accepting it creates the skill in the destination. The destination is the
// fixed, idempotently created `e2e-move-target` fixture the §70 spec also uses; the skill is deleted
// in `finally` (or the proposal, when the run stopped before the accept).
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";
import type { Page } from "@playwright/test";

const DEST_SLUG = "e2e-move-target";
const DEST_NAME = "E2E Move Target";

async function namespaceIds(page: Page): Promise<{ dest: string; teamA: string }> {
  // 201 on first run, 422 ("already exists") afterwards — both fine.
  await page.request.post("/api/admin/namespaces", { data: { slug: DEST_SLUG, displayName: DEST_NAME, requireReview: true } });
  const list = (await (await page.request.get("/api/namespaces/share-targets")).json()) as { namespaces: { id: string; slug: string }[] };
  const dest = list.namespaces.find((n) => n.slug === DEST_SLUG);
  const teamA = list.namespaces.find((n) => n.slug === "team-a");
  expect(dest && teamA, "both namespaces exist").toBeTruthy();
  return { dest: dest!.id, teamA: teamA!.id };
}

test("§74 move a new-skill proposal to another namespace, then accept it there", async ({ page }) => {
  test.setTimeout(240_000);
  await devSignIn(page);
  const { dest, teamA } = await namespaceIds(page);
  const slug = `e2e-retarget-${Date.now().toString(36)}`;
  const id = await createHostedProposal(page, { namespaceSlug: "team-a", skillSlug: slug, visibility: "namespace" });
  let accepted = false;
  try {
    await gotoLoaded(page, `/proposals/${id}`, `/api/proposals/${id}`);
    await page.getByRole("button", { name: "✎ Edit" }).click();
    const field = page.getByTestId("review-retarget-namespace");
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.locator("select").selectOption(dest);
    await expect(page.getByTestId("review-retarget-banner")).toContainText(`You also review ${DEST_SLUG}`);
    // The Decision block offers the move; the ordinary decisions wait.
    const moveBtn = page.getByTestId("move-proposal");
    await expect(moveBtn).toHaveText(`Move to @${DEST_SLUG}`);
    await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();

    await clickAndAwait(page, () => moveBtn.click(), `/api/proposals/${id}/actions`, { method: "POST" });
    await expect.poll(async () => (await (await page.request.get(`/api/proposals/${id}`)).json()).targetNamespaceSlug, { timeout: 15_000 }).toBe(DEST_SLUG);
    const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
    expect(detail.state).toBe("proposed");
    const latest = detail.revisions.at(-1);
    expect(latest.note).toBe(`Moved from @team-a to @${DEST_SLUG}`);
    expect(latest.payload.metadata.sharedNamespaceIds, "team-a joins the shared list").toEqual([teamA]);
    // The page reloads under the new namespace, with the move in its History.
    await expect(page.locator(".meta .ns")).toHaveText(`@${DEST_SLUG}`, { timeout: 15_000 });
    await expect(page.getByText(`Moved from @team-a to @${DEST_SLUG}`)).toBeVisible();

    // Accept it in the destination (API): the skill is created there, never in team-a.
    await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
    const revisionNo: number = (await (await page.request.get(`/api/proposals/${id}`)).json()).revisions.at(-1).revisionNo;
    let r = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
    if (r.status() === 409 && (await r.json()).requiresOverride) {
      r = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" } });
    }
    expect(r.ok(), await r.text()).toBeTruthy();
    accepted = true;
    expect((await page.request.get(`/api/skills/${DEST_SLUG}/${slug}`)).ok(), "the skill lives in the destination").toBeTruthy();
    expect((await page.request.get(`/api/skills/team-a/${slug}`)).status(), "nothing was created in team-a").toBe(404);
  } finally {
    if (accepted) await deleteSkillFully(page, DEST_SLUG, slug);
    else await page.request.delete(`/api/proposals/${id}`);
  }
});
