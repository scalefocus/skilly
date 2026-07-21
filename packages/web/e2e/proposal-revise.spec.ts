// e2e: proposer mid-review edits (`revise`) + revision-pinned accept (SKILLY_SPEC.md §8).
// While a proposal sits in proposed/under_review, the submitter can update it in place — new
// revision, NO state change, reviewers notified — with the proposed semver locked; and `accept`
// must carry the revision the reviewer inspected (a stale pin bounces with 409). Runs against
// the dev stack (SKILLY_DEV_AUTH=1); opt-in, not part of the default `pnpm -r test`.
//
// Mostly API-driven (page.request shares the signed-in cookie jar) with one UI pass over the
// proposal page's revise affordances. Everything it creates is removed at the end via the
// reviewer housekeeping DELETE (allowed in every state except accepted), so the dev catalog
// stays clean — only orphan staged upload objects remain, like the chunked-upload e2e's.
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import { test, expect, type Page } from "@playwright/test";

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as
// e2e/shots.mjs. page.request shares the page's cookie jar, so later API calls are authed.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  expect(res.ok()).toBeTruthy();
}

/** A tiny valid .skill (zip) bundle whose SKILL.md name matches `slug`. `salt` makes the
 *  content-set digest unique per build so duplicate detection never trips across runs. */
function buildSkillBundle(slug: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "SKILL.md",
    Buffer.from(`---\nname: ${slug}\ndescription: revise e2e fixture (safe to delete)\n---\n\n# ${slug}\n\nFixture for the §8 revise e2e. salt=${randomBytes(8).toString("hex")}\n`),
  );
  return zip.toBuffer();
}

async function uploadBundle(page: Page, slug: string): Promise<{ artifactObjectKey: string; artifactSha256: string; contentSha256: string; artifactFilename: string | null }> {
  const res = await page.request.post("/api/uploads", {
    multipart: {
      bundle: { name: `${slug}.skill`, mimeType: "application/zip", buffer: buildSkillBundle(slug) },
      skillSlug: slug,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

test.describe.serial("proposer mid-review revise + revision-pinned accept (§8)", () => {
  test("revise in place, semver locked, pinned accept bounces on a stale revision", async ({ page }) => {
    await devSignIn(page);
    const slug = `revise-e2e-${Date.now().toString(36)}`;

    // Submit a NEW-skill hosted proposal into `global` (always require_review, §4).
    const up1 = await uploadBundle(page, slug);
    const created = await page.request.post("/api/proposals", {
      data: {
        namespaceSlug: "global",
        semver: "1.0.0",
        metadata: { skillSlug: slug, title: "Revise E2E", description: "d", toolHarness: "generic", visibility: "org", categories: [], tags: [] },
        ...up1,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();

    try {
      // ── UI: the submitter sees the revise affordances while the proposal is `proposed`. ──
      await page.goto(`/proposals/${id}`);
      await expect(page.getByRole("heading", { name: "Update proposal" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("the proposed version doesn’t change")).toBeVisible();
      // Open the edit form: the semver input is read-only (locked mid-review).
      await page.getByRole("button", { name: "✎ Edit" }).click();
      await expect(page.getByText("The proposed version is locked while the proposal is in review.")).toBeVisible();
      await expect(page.getByPlaceholder("1.2.3")).toHaveAttribute("readonly", "");
      // Save is a no-op guard round-trip: nothing changed yet → the server answers 422.
      // Generous timeout: the FIRST hit on the actions route pays the dev-server compile.
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/nothing changed — edit at least one field/i)).toBeVisible({ timeout: 15_000 });

      // ── API: a real revise — new title + replacement bundle. No state change, revision 2. ──
      const detail1 = await (await page.request.get(`/api/proposals/${id}`)).json();
      expect(detail1.state).toBe("proposed");
      expect(detail1.allowedActions).toContain("revise");
      const basePayload = detail1.revisions.at(-1).payload;
      const up2 = await uploadBundle(page, slug);
      const revised = await page.request.post(`/api/proposals/${id}/actions`, {
        data: {
          action: "revise",
          note: "swapped the bundle",
          newPayload: { ...basePayload, metadata: { ...basePayload.metadata, title: "Revise E2E v2" }, ...up2 },
        },
      });
      expect(revised.ok(), await revised.text()).toBeTruthy();
      expect((await revised.json()).state).toBe("proposed");

      const detail2 = await (await page.request.get(`/api/proposals/${id}`)).json();
      expect(detail2.state).toBe("proposed");
      expect(detail2.revisions).toHaveLength(2);
      expect(detail2.revisions.at(-1).payload.metadata.title).toBe("Revise E2E v2");
      expect(detail2.revisions.at(-1).payload.artifactObjectKey).toBe(up2.artifactObjectKey);
      expect(detail2.proposedSemver).toBe("1.0.0");

      // A revise must not smuggle a semver change past the lock.
      const semverLocked = await page.request.post(`/api/proposals/${id}/actions`, {
        data: { action: "revise", newSemver: "2.0.0", newPayload: { ...detail2.revisions.at(-1).payload, metadata: { ...detail2.revisions.at(-1).payload.metadata, title: "v3" } } },
      });
      expect(semverLocked.status()).toBe(422);
      expect((await semverLocked.json()).error).toMatch(/version can’t change while/);

      // ── Revision-pinned accept: start review, then accept with a STALE pin → 409. ──
      const started = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
      expect(started.ok(), await started.text()).toBeTruthy();
      // Revise survives start_review (under_review is proposer-editable too).
      const revised2 = await page.request.post(`/api/proposals/${id}/actions`, {
        data: { action: "revise", newPayload: { ...detail2.revisions.at(-1).payload, metadata: { ...detail2.revisions.at(-1).payload.metadata, title: "Revise E2E v3" } } },
      });
      expect(revised2.ok(), await revised2.text()).toBeTruthy();
      expect((await revised2.json()).state).toBe("under_review");

      const staleAccept = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo: 2 } });
      expect(staleAccept.status()).toBe(409);
      expect((await staleAccept.json()).error).toMatch(/changed since you reviewed it/);
      const unpinnedAccept = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept" } });
      expect(unpinnedAccept.status()).toBe(422);

      // Still un-materialized and revisable — nothing was published by the bounced accepts.
      const detail3 = await (await page.request.get(`/api/proposals/${id}`)).json();
      expect(detail3.state).toBe("under_review");
      expect(detail3.materializedVersionId).toBeNull();
    } finally {
      // Reviewer housekeeping delete (§8) — removes the proposal, its revisions, and the review
      // discussion; legal in every state except accepted, so the dev catalog stays clean.
      const del = await page.request.delete(`/api/proposals/${id}`);
      expect(del.status(), await del.text()).toBeLessThan(300);
    }
  });
});
