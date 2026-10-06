// e2e: the system quality rating from upload to catalog (SKILLY_SPEC.md §41.13). A hosted
// proposal whose bundle carries a README and a vague description:
//   1. the upload response and the review page's Quality section list FS-003 / DS-001 / DS-003
//      with the rules-only stars;
//   2. after publish the skill payload carries `quality` + `qualityDetail`, the detail page shows
//      the Quality card with the findings, and Re-assess (the dev user is a platform admin)
//      resets and re-scores it;
//   3. the catalog's "Highest quality" sort and the ★ 4+ chip reorder / filter the grid, and the
//      shield badge sits beside the user rating on the card.
// AI is not configured in the e2e stack, so every score is rules-only. Self-cleaning.
import AdmZip from "adm-zip";
import { randomBytes } from "node:crypto";
import { test, expect, devSignIn } from "./fixtures";
import { deleteSkillFully } from "./helpers/skills";
import { gotoReady, NAV_TIMEOUT } from "./helpers/ready";

function bundle(slug: string, md: string, extra: Record<string, string>): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(md.replace(/SLUG/g, slug) + `\n<!-- salt=${randomBytes(8).toString("hex")} -->\n`));
  for (const [p, c] of Object.entries(extra)) zip.addFile(p, Buffer.from(c));
  return zip.toBuffer();
}

const BAD_MD = "---\nname: SLUG\ndescription: Helps with projects.\n---\n\n# SLUG\n\nMake sure to validate things properly.\n";
const GOOD_MD = `---
name: SLUG
description: Processes PDF legal documents for contract review. Use this when the user says "review this contract". Do not use for spreadsheets.
license: MIT
compatibility: Python 3
metadata:
  version: 1.0.0
  author: QA
---
# SLUG

## Instructions

1. Run \`python scripts/run.py\`
   Returns JSON.

## Examples

User says: "review this contract"

## Troubleshooting

If it fails, retry.
`;

async function publish(page: Parameters<typeof devSignIn>[0], slug: string, md: string, extra: Record<string, string>): Promise<{ proposalId: string; upload: Record<string, unknown> }> {
  const up = await page.request.post("/api/uploads", {
    multipart: { bundle: { name: `${slug}.skill`, mimeType: "application/zip", buffer: bundle(slug, md, extra) }, skillSlug: slug },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const upload = await up.json();
  const res = await page.request.post("/api/proposals", {
    data: {
      namespaceSlug: "global",
      semver: "1.0.0",
      metadata: { skillSlug: slug, title: `E2E ${slug}`, description: "e2e fixture proposal (safe to delete)", toolHarness: "generic", visibility: "org", categories: [] },
      artifactObjectKey: upload.artifactObjectKey,
      artifactSha256: upload.artifactSha256,
      contentSha256: upload.contentSha256,
      artifactFilename: upload.artifactFilename,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const proposalId = (await res.json()).id as string;
  const detail = await (await page.request.get(`/api/proposals/${proposalId}`)).json();
  const revisionNo: number = detail.revisions.at(-1).revisionNo;
  expect((await page.request.post(`/api/proposals/${proposalId}/actions`, { data: { action: "start_review" } })).ok()).toBeTruthy();
  const accepted = await page.request.post(`/api/proposals/${proposalId}/actions`, { data: { action: "accept", revisionNo } });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  return { proposalId, upload };
}

test.describe.serial("skill quality rating (§41)", () => {
  test("upload lint → review section → published card, detail card, re-assess, catalog sort and facet", async ({ page }) => {
    await devSignIn(page);
    const stamp = Date.now().toString(36);
    const badSlug = `e2e-quality-bad-${stamp}`;
    const goodSlug = `e2e-quality-good-${stamp}`;

    try {
      // ── 1. Upload lint + the review page's Quality section (rules only). ──
      const up = await page.request.post("/api/uploads", {
        multipart: { bundle: { name: `${badSlug}.skill`, mimeType: "application/zip", buffer: bundle(badSlug, BAD_MD, { "README.md": "x" }) }, skillSlug: badSlug },
      });
      expect(up.ok(), await up.text()).toBeTruthy();
      const upload = await up.json();
      expect(upload.quality).toBeTruthy();
      expect(upload.quality.rulesScore).toBeLessThan(40);
      const rules = upload.quality.findings.map((f: { rule: string }) => f.rule);
      expect(rules).toEqual(expect.arrayContaining(["FS-003", "DS-001", "DS-003"]));
      // Quality findings are info-level and never raise the scan severity.
      expect(upload.scan.severity).toBe("info");

      const res = await page.request.post("/api/proposals", {
        data: {
          namespaceSlug: "global",
          semver: "1.0.0",
          metadata: { skillSlug: badSlug, title: `E2E ${badSlug}`, description: "e2e fixture proposal (safe to delete)", toolHarness: "generic", visibility: "org", categories: [] },
          artifactObjectKey: upload.artifactObjectKey,
          artifactSha256: upload.artifactSha256,
          contentSha256: upload.contentSha256,
          artifactFilename: upload.artifactFilename,
        },
      });
      expect(res.status(), await res.text()).toBe(201);
      const proposalId = (await res.json()).id as string;

      await gotoReady(page, `/proposals/${proposalId}`);
      const section = page.getByTestId("quality-section");
      await expect(section).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(section.getByTestId("quality-section-stars")).toHaveText(/^(0\.5|1|1\.5|2)$/);
      await expect(section.locator('[data-rule="FS-003"]').first()).toBeVisible();
      await expect(section.getByText("README in the skill folder").first()).toBeVisible();

      // Accept it (no override needed — quality never gates).
      const detail = await (await page.request.get(`/api/proposals/${proposalId}`)).json();
      const revisionNo: number = detail.revisions.at(-1).revisionNo;
      expect((await page.request.post(`/api/proposals/${proposalId}/actions`, { data: { action: "start_review" } })).ok()).toBeTruthy();
      const accepted = await page.request.post(`/api/proposals/${proposalId}/actions`, { data: { action: "accept", revisionNo } });
      expect(accepted.ok(), await accepted.text()).toBeTruthy();

      // ── 2. The skill payload and the detail page's Quality card. ──
      const skill = await (await page.request.get(`/api/skills/global/${badSlug}`)).json();
      expect(skill.quality).toBeTruthy();
      expect(skill.quality.mode).toBe("rules");
      expect(skill.quality.stars).toBeLessThanOrEqual(2);
      expect(skill.qualityDetail.findings.map((f: { rule: string }) => f.rule)).toEqual(expect.arrayContaining(["FS-003"]));
      expect(skill.qualityDetail.canReassess).toBe(true);
      expect(skill.versions[0].quality.stars).toBe(skill.quality.stars);
      const v = await (await page.request.get(`/api/skills/global/${badSlug}/versions/1.0.0/quality`)).json();
      expect(v.quality.finalScore).toBe(skill.qualityDetail.finalScore);

      await gotoReady(page, `/skills/global/${badSlug}`);
      const card = page.getByTestId("quality-card");
      await expect(card).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(card.getByTestId("quality-mode")).toHaveText("Rules only");
      await expect(card.locator('[data-rule="FS-003"]').first()).toBeVisible();
      await expect(page.getByTestId("version-quality").first()).toBeVisible();

      // Re-assess: confirm dialog → fresh score, same value (nothing changed), audit on the server.
      page.once("dialog", (d) => d.accept());
      await card.getByTestId("quality-reassess").click();
      await expect(card.getByTestId("quality-score")).toContainText(`${skill.qualityDetail.finalScore} / 100`, { timeout: NAV_TIMEOUT });

      // ── 3. Catalog: a good skill outranks the bad one under "Highest quality"; ★ 4+ hides the bad one. ──
      await publish(page, goodSlug, GOOD_MD, { "scripts/run.py": "import json\n" });
      const good = await (await page.request.get(`/api/skills/global/${goodSlug}`)).json();
      expect(good.quality.stars).toBe(5);

      const sorted = await (await page.request.get(`/api/skills?sort=quality&q=e2e-quality-${stamp}`)).json();
      const slugs = sorted.skills.map((s: { skillSlug: string }) => s.skillSlug);
      expect(slugs.indexOf(goodSlug)).toBeLessThan(slugs.indexOf(badSlug));
      const filtered = await (await page.request.get(`/api/skills?minQuality=4&q=e2e-quality-${stamp}`)).json();
      const fslugs = filtered.skills.map((s: { skillSlug: string }) => s.skillSlug);
      expect(fslugs).toContain(goodSlug);
      expect(fslugs).not.toContain(badSlug);
      expect((await page.request.get(`/api/skills?minQuality=2`)).status()).toBe(422);

      await gotoReady(page, `/catalog?q=e2e-quality-${stamp}`);
      const goodCard = page.locator(`a.skill-card[href="/skills/global/${goodSlug}"]`);
      await expect(goodCard).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(goodCard.getByTestId("quality-badge")).toHaveText(/5$/);
      await page.getByTestId("sort-quality").click();
      await expect(page.locator("a.skill-card").first()).toHaveAttribute("href", `/skills/global/${goodSlug}`, { timeout: NAV_TIMEOUT });
      await page.getByTestId("min-quality-4").click();
      await expect(page.locator(`a.skill-card[href="/skills/global/${badSlug}"]`)).toHaveCount(0, { timeout: NAV_TIMEOUT });
      await expect(goodCard).toBeVisible();
    } finally {
      await deleteSkillFully(page, "global", badSlug);
      await deleteSkillFully(page, "global", goodSlug);
    }
  });
});
