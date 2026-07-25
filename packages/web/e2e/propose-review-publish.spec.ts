// e2e: the core governance journey — propose → review → publish (SKILLY_SPEC.md §8). A brand-new
// hosted skill is proposed into `global` (always require_review, §4), the reviewer starts review
// and accepts with the revision they inspected (revision-pinned accept), and acceptance
// materializes an active skill version that then shows in the catalog. The dev-admin is both a
// proposer (any authenticated user may propose) and a reviewer (platform admin), so the single dev
// identity drives the whole chain.
//
// Mostly API-driven (page.request shares the signed-in cookie jar) with a UI pass confirming the
// proposal and the published skill render. Self-cleaning: the created skill is archived+deleted at
// the end, so the dev catalog is left exactly as it was (only an orphan staged upload object
// remains, like the other upload-driven specs).
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";

test.describe.serial("propose → review → publish (§8)", () => {
  test("a proposal is reviewed, accepted, materialized and appears in the catalog", async ({ page }) => {
    await devSignIn(page);
    const slug = `e2e-publish-${Date.now().toString(36)}`;
    const title = "E2E Publish Journey";

    const id = await createHostedProposal(page, { namespaceSlug: "global", skillSlug: slug, title });

    try {
      // ── UI: the proposal detail renders (first hit pays the dev-server compile). ──
      await page.goto(`/proposals/${id}`);
      await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });

      // Fresh proposal sits in `proposed` with a single revision.
      const detail1 = await (await page.request.get(`/api/proposals/${id}`)).json();
      expect(detail1.state).toBe("proposed");
      const last = detail1.revisions.at(-1);
      const revisionNo: number = last.revisionNo ?? last.revision_no ?? detail1.revisions.length;

      // ── start_review (reviewer) → under_review. ──
      const started = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
      expect(started.ok(), await started.text()).toBeTruthy();
      expect((await (await page.request.get(`/api/proposals/${id}`)).json()).state).toBe("under_review");

      // ── accept, pinned to the reviewed revision. A high/critical scan finding would demand an
      //    explicit override; a trivial fixture bundle scans clean, but handle the override path
      //    defensively so the journey doesn't depend on the scanner's verdict. ──
      let accept = await page.request.post(`/api/proposals/${id}/actions`, {
        data: { action: "accept", revisionNo },
      });
      // Playwright buffers the body, so reading .json() here and .text() below is safe.
      if (accept.status() === 409 && (await accept.json()).requiresOverride) {
        accept = await page.request.post(`/api/proposals/${id}/actions`, {
          data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" },
        });
      }
      expect(accept.ok(), await accept.text()).toBeTruthy();

      const done = await (await page.request.get(`/api/proposals/${id}`)).json();
      expect(done.state).toBe("accepted");
      expect(done.materializedVersionId).toBeTruthy();

      // ── The published skill is now a real catalog entry. ──
      const skill = await page.request.get(`/api/skills/global/${slug}`);
      const skillText = await skill.text();
      expect(skill.ok(), skillText).toBeTruthy();
      expect(skillText).toContain(title); // the title appears somewhere in the detail payload

      // UI: its detail page renders with the title.
      await page.goto(`/skills/global/${slug}`);
      await expect(page.getByRole("heading", { name: title }).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await deleteSkillFully(page, "global", slug);
    }
  });
});
