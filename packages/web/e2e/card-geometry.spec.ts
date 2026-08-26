// e2e: catalog cards are fixed-height (SKILLY_SPEC.md §14 Fixed-height catalog cards). Seeds a
// deliberately maximal skill (long description, long title) next to a minimal one and asserts every
// card in a grid reports the SAME height — the regression that actually matters, since an unclamped
// description used to inflate its whole grid row and leave its siblings with a dead gap. Per-zone
// line-height arithmetic is deliberately NOT asserted: it breaks whenever a font or type scale
// changes, without any user-visible regression having occurred.
// Categories are not seeded: they are a controlled vocabulary (§10) so the names would have to be
// discovered at runtime, and the categories row is structurally height-bounded anyway
// (.skill-card-cats is one line, min-height 30px) — the description was the variable-height zone.
// Runs against the dev stack (SKILLY_DEV_AUTH=1, platform-admin dev user); opt-in, not part of the
// default `pnpm -r test`. Self-cleaning: both seeded skills are archived + deleted at the end.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";

const LONG_DESC =
  "An enterprise-grade governance layer for SKILL.md agent skills, with Entra ID identity, "
  + "namespace-scoped visibility, review gating, immutable versioning, and a git-serving install "
  + "gateway. Handles hosted bundles and mirrored pointer skills alike, with full audit coverage of "
  + "every mint, fetch and uninstall across the organisation and all of its business units.";
const LONG_TITLE = "E2E Enterprise Document Intelligence and Compliance Reporting Toolkit";

/** Propose → start_review → accept, so the skill lands in the catalog. Mirrors the journey in
 *  propose-review-publish.spec.ts, including its defensive scan-override path. */
async function publish(page: Page, slug: string, title: string, description: string) {
  const id = await createHostedProposal(page, { namespaceSlug: "global", skillSlug: slug, title, description });
  const started = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
  expect(started.ok(), await started.text()).toBeTruthy();
  const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
  const last = detail.revisions.at(-1);
  const revisionNo: number = last.revisionNo ?? last.revision_no ?? detail.revisions.length;
  let accept = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
  if (accept.status() === 409 && (await accept.json()).requiresOverride) {
    accept = await page.request.post(`/api/proposals/${id}/actions`, {
      data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" },
    });
  }
  expect(accept.ok(), await accept.text()).toBeTruthy();
}

/** Every `.skill-card` height in the page's card grids, rounded — sub-pixel layout noise would
 *  otherwise make an identical layout look ragged. */
async function cardHeights(page: Page): Promise<number[]> {
  return page.$$eval(".card-grid .skill-card", (cards) =>
    cards.map((c) => Math.round(c.getBoundingClientRect().height)));
}

test.describe.serial("catalog cards are fixed-height (§14)", () => {
  const stamp = Date.now().toString(36);
  const maximal = `e2e-card-max-${stamp}`;
  const minimal = `e2e-card-min-${stamp}`;

  test("a maximal card and a minimal card render at exactly the same height", async ({ page }) => {
    await devSignIn(page);
    await publish(page, maximal, LONG_TITLE, LONG_DESC);
    await publish(page, minimal, "E2E Min", "Short.");

    try {
      await page.goto("/catalog");
      // Both seeded cards must be on screen before measuring (first hit pays the dev compile).
      await expect(page.locator(`a[href="/skills/global/${maximal}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(`a[href="/skills/global/${minimal}"]`)).toBeVisible();

      const wide = await cardHeights(page);
      expect(wide.length).toBeGreaterThanOrEqual(2);
      expect(new Set(wide).size, `card heights should be identical, got ${wide.join(", ")}`).toBe(1);

      // The same invariant must hold in a single-column phone layout — no breakpoint relaxes the
      // reserves (§14), so the heights stay locked together there too.
      await page.setViewportSize({ width: 375, height: 900 });
      await expect(page.locator(`a[href="/skills/global/${maximal}"]`)).toBeVisible();
      const narrow = await cardHeights(page);
      expect(new Set(narrow).size, `heights at 375px should be identical, got ${narrow.join(", ")}`).toBe(1);

      // And no horizontal spill at the phone width (§14 Narrow-viewport containment).
      const spills = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(spills, "the catalog must not scroll horizontally at 375px").toBe(false);
    } finally {
      await deleteSkillFully(page, "global", maximal);
      await deleteSkillFully(page, "global", minimal);
    }
  });
});
