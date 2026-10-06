// e2e: sharing a restricted skill with other namespaces (SKILLY_SPEC.md §42). Runs against the dev
// stack (SKILLY_DEV_AUTH=1) as the seeded platform admin, who may share and revoke on any skill.
//
// Journey: a restricted `team-a` skill is proposed already shared with a second namespace →
// accepted → the detail page's Shared with card lists it → revoking via the chip's × removes it →
// re-sharing through the card's namespace picker adds it back → a "Keep current files" new
// version whose ONLY change is the share list is a valid proposal, and accepting it syncs the
// grants. (The grantee-side view — the catalog marker, invisibility to outsiders — needs a second
// identity, which the single dev user can't provide; grants.dbtest.ts covers it against the DB.)
//
// The dev stack has no namespace delete, so the share-target namespace is a fixed, idempotently
// created fixture (`e2e-share-target`); the skill itself is deleted in `finally`.
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";
import { acceptNextDialog, gotoLoaded } from "./helpers/ready";
import type { Page } from "@playwright/test";

const TARGET_SLUG = "e2e-share-target";
const TARGET_NAME = "E2E Share Target";

async function ensureTargetNamespace(page: Page): Promise<string> {
  // 201 on first run, 422 ("already exists") afterwards — both fine.
  await page.request.post("/api/admin/namespaces", { data: { slug: TARGET_SLUG, displayName: TARGET_NAME, requireReview: true } });
  const list = (await (await page.request.get("/api/namespaces/share-targets")).json()) as { namespaces: { id: string; slug: string }[] };
  const ns = list.namespaces.find((n) => n.slug === TARGET_SLUG);
  expect(ns, "the share-target namespace exists").toBeTruthy();
  expect(list.namespaces.some((n) => n.slug === "global"), "global is never a share target").toBe(false);
  return ns!.id;
}

async function acceptProposal(page: Page, id: string): Promise<void> {
  await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
  const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
  const revisionNo: number = detail.revisions.at(-1).revisionNo;
  let accept = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
  if (accept.status() === 409 && (await accept.json()).requiresOverride) {
    accept = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" } });
  }
  expect(accept.ok(), await accept.text()).toBeTruthy();
}

const grantIds = async (page: Page, slug: string): Promise<string[]> =>
  ((await (await page.request.get(`/api/skills/team-a/${slug}/grants`)).json()) as { grants: { namespaceId: string }[] }).grants.map((g) => g.namespaceId);

test.describe("§42 namespace sharing", () => {
  test.describe.configure({ mode: "serial" });

  test("share on propose, revoke + re-share on the detail page, share-only new version", async ({ page }) => {
    test.setTimeout(180_000);
    await devSignIn(page);
    const targetId = await ensureTargetNamespace(page);
    const slug = `e2e-shared-${Date.now().toString(36)}`;

    // ── Propose a restricted team-a skill already shared with the target, then accept. ──
    const id = await createHostedProposal(page, { namespaceSlug: "team-a", skillSlug: slug, visibility: "namespace" });
    try {
      // createHostedProposal has no share field — add it with the proposer's mid-review `revise`,
      // carrying the list exactly as the propose form / review page picker would (§8, §42.3).
      const before = await (await page.request.get(`/api/proposals/${id}`)).json();
      const payload = before.revisions.at(-1).payload;
      const revised = await page.request.post(`/api/proposals/${id}/actions`, {
        data: { action: "revise", newPayload: { ...payload, metadata: { ...payload.metadata, sharedNamespaceIds: [targetId] } } },
      });
      expect(revised.ok(), await revised.text()).toBeTruthy();
      await acceptProposal(page, id);
      expect(await grantIds(page, slug)).toEqual([targetId]);

      // ── The detail page lists the grant on the Shared with card. ──
      await gotoLoaded(page, `/skills/team-a/${slug}`, `/api/skills/team-a/${slug}/grants`);
      const card = page.getByTestId("shared-with-card");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByText(TARGET_NAME)).toBeVisible();

      // ── Revoke via the chip's × (confirm dialog). ──
      const confirmed = acceptNextDialog(page);
      await card.getByRole("button", { name: `stop sharing with ${TARGET_NAME}` }).click();
      await confirmed;
      await expect(card.getByText(TARGET_NAME)).toHaveCount(0, { timeout: 15_000 });
      expect(await grantIds(page, slug)).toEqual([]);

      // ── Re-share through the card's namespace picker. ──
      await card.getByRole("textbox", { name: "Share with namespaces" }).fill("E2E Share");
      await card.getByRole("option", { name: new RegExp(TARGET_NAME) }).click();
      await expect(card.getByText(TARGET_NAME)).toBeVisible({ timeout: 15_000 });
      expect(await grantIds(page, slug)).toEqual([targetId]);

      // ── A Keep-current-files new version whose ONLY change is the share list is valid. ──
      const meta = (await (await page.request.get(`/api/skills/team-a/${slug}`)).json()).meta;
      const nv = await page.request.post("/api/proposals", {
        data: {
          namespaceSlug: "team-a", targetSkillSlug: slug, semver: "1.0.1", reuseCurrentFiles: true,
          metadata: {
            skillSlug: slug, title: meta.title, description: meta.description, toolHarness: meta.toolHarness,
            categories: meta.categories ?? [], visibility: "namespace", whatChanged: "Stop sharing with the e2e target",
            sharedNamespaceIds: [],
          },
        },
      });
      expect(nv.status(), await nv.text()).toBe(201);
      await acceptProposal(page, (await nv.json()).id);
      expect(await grantIds(page, slug), "accepting the share-only version synced the grants").toEqual([]);

      // And the unchanged version (same list as the skill) is rejected by the no-op guard.
      const noop = await page.request.post("/api/proposals", {
        data: {
          namespaceSlug: "team-a", targetSkillSlug: slug, semver: "1.0.2", reuseCurrentFiles: true,
          metadata: {
            skillSlug: slug, title: meta.title, description: meta.description, toolHarness: meta.toolHarness,
            categories: meta.categories ?? [], visibility: "namespace", whatChanged: "nothing", sharedNamespaceIds: [],
          },
        },
      });
      expect(noop.status()).toBe(422);
      expect(await noop.text()).toMatch(/nothing changed/i);
    } finally {
      await deleteSkillFully(page, "team-a", slug);
    }
  });
});
