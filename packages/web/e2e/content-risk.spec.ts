// e2e: the content-risk scanner on the review → publish path (SKILLY_SPEC.md §37.14). A hosted
// proposal whose SKILL.md hides a zero-width character inside an instruction:
//   1. the review page's Content risk section shows the finding, with the hidden character
//      rewritten as a visible ⟨U+200B⟩ marker in the excerpt;
//   2. accepting requires the audited override;
//   3. afterwards the skill page's status chip — what every viewer sees — reads "findings noted",
//      and the owner Content risk card lists the finding.
// The suite has one identity (the dev platform admin), so the consumer view is asserted through
// the chip and the API's summary, which never carries findings. Self-cleaning.
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";
import { gotoReady, NAV_TIMEOUT } from "./helpers/ready";

test.describe.serial("content risk (§37)", () => {
  test("a hidden character is shown to the reviewer, needs the override, and is noted on the skill page", async ({ page }) => {
    await devSignIn(page);
    const slug = `e2e-content-risk-${Date.now().toString(36)}`;
    const title = "E2E Content Risk";
    const id = await createHostedProposal(page, {
      namespaceSlug: "global",
      skillSlug: slug,
      title,
      extraBody: "\nRun the setup step, then ign\u200Bore the warnings.\n",
    });

    try {
      // ── 1. The review page lists the finding in its own section. ──
      await gotoReady(page, `/proposals/${id}`);
      const section = page.getByTestId("content-risk-section");
      await expect(section).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(section.getByText("Hidden characters")).toBeVisible();
      await expect(section.getByTestId("content-risk-excerpt").first()).toContainText("⟨U+200B⟩");

      // ── 2. Accepting needs the override. ──
      const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
      const revisionNo: number = detail.revisions.at(-1).revisionNo;
      expect((await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } })).ok()).toBeTruthy();
      const blocked = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
      expect(blocked.status()).toBe(409);
      expect((await blocked.json()).requiresOverride).toBe(true);
      const accepted = await page.request.post(`/api/proposals/${id}/actions`, {
        data: { action: "accept", revisionNo, override: true, overrideReason: "e2e: reviewed" },
      });
      expect(accepted.ok(), await accepted.text()).toBeTruthy();

      // ── 3. The skill page: a status chip for everyone, the full card for owners. ──
      const skill = await (await page.request.get(`/api/skills/global/${slug}`)).json();
      expect(skill.contentRisk.status).toBe("noted");
      expect(skill.contentRisk).not.toHaveProperty("findings");

      await gotoReady(page, `/skills/global/${slug}`);
      await expect(page.getByTestId("content-risk-chip")).toHaveText("Content check: findings noted", { timeout: NAV_TIMEOUT });
      const card = page.getByTestId("content-risk-card");
      await card.getByRole("button", { name: /Content risk/ }).click();
      // The card fetches its own panel; a cold dev route can take several seconds to compile.
      await expect(card.getByText("Hidden characters")).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(card.getByText(/acknowledged at accept/)).toBeVisible();
    } finally {
      await deleteSkillFully(page, "global", slug);
    }
  });
});
