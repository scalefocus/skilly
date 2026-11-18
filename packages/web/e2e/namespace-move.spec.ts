// e2e: moving a skill to another namespace through a new-version proposal (SKILLY_SPEC.md §70).
// Runs against the dev stack (SKILLY_DEV_AUTH=1) as the seeded platform admin, who may act at both
// stages of the move.
//
// Journey: a restricted `team-a` skill is accepted → the new-version form picks another namespace
// (the move banner appears, the old owner joins the share list) and submits with Keep current files →
// the owner's accept leaves it Awaiting destination → the proposal page shows the two-step progress
// and the destination's "Accept & move" button → accepting moves the skill: its API answers at the
// new address, the old API address resolves to it, the old page URL redirects, and the old owner
// keeps access as a grantee. (The destination-only reviewer view, the stale-move 409 and the alias
// reservation need several identities — skillMoves.dbtest.ts covers them against the DB.)
//
// The dev stack has no namespace delete, so the destination is a fixed, idempotently created fixture
// (`e2e-move-target`); the skill is deleted in `finally` at whichever address it ended up.
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";
import type { Page } from "@playwright/test";

const DEST_SLUG = "e2e-move-target";
const DEST_NAME = "E2E Move Target";

async function ensureDestination(page: Page): Promise<string> {
  // 201 on first run, 422 ("already exists") afterwards — both fine.
  await page.request.post("/api/admin/namespaces", { data: { slug: DEST_SLUG, displayName: DEST_NAME, requireReview: true } });
  const list = (await (await page.request.get("/api/namespaces/share-targets")).json()) as { namespaces: { id: string; slug: string }[] };
  const ns = list.namespaces.find((n) => n.slug === DEST_SLUG);
  expect(ns, "the destination namespace exists").toBeTruthy();
  return ns!.id;
}

async function accept(page: Page, id: string): Promise<string> {
  const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
  const revisionNo: number = detail.revisions.at(-1).revisionNo;
  let r = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
  if (r.status() === 409 && (await r.json()).requiresOverride) {
    r = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" } });
  }
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { state: string }).state;
}

test.describe("§70 moving a skill to another namespace", () => {
  test.describe.configure({ mode: "serial" });

  test("propose a move, owner approves, destination accepts, old address redirects", async ({ page }) => {
    test.setTimeout(240_000);
    await devSignIn(page);
    const destId = await ensureDestination(page);
    const slug = `e2e-move-${Date.now().toString(36)}`;
    let home = "team-a";

    const first = await createHostedProposal(page, { namespaceSlug: "team-a", skillSlug: slug, visibility: "namespace" });
    try {
      await page.request.post(`/api/proposals/${first}/actions`, { data: { action: "start_review" } });
      expect(await accept(page, first)).toBe("accepted");
      const teamA = ((await (await page.request.get("/api/namespaces/share-targets")).json()) as { namespaces: { id: string; slug: string }[] })
        .namespaces.find((n) => n.slug === "team-a")!.id;

      // ── The new-version form: pick the destination; the banner explains the move. ──
      await gotoLoaded(page, `/propose?newVersion=1&ns=team-a&slug=${slug}`, `/api/skills/team-a/${slug}`);
      const picker = page.getByTestId("move-namespace");
      await expect(picker).toBeVisible({ timeout: 30_000 });
      await picker.selectOption(destId);
      const banner = page.getByTestId("move-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(`${DEST_SLUG}/${slug}`);
      await expect(banner).toContainText("keeps access");
      const submitted = page.waitForURL(/\/proposals\/[0-9a-f-]{36}$/, { timeout: 60_000 });
      await page.getByRole("button", { name: /Submit for review/ }).click();
      await submitted;
      const moveId = page.url().split("/").at(-1)!;

      const proposal = await (await page.request.get(`/api/proposals/${moveId}`)).json();
      expect(proposal.destination?.slug).toBe(DEST_SLUG);
      expect(proposal.revisions.at(-1).payload.metadata.sharedNamespaceIds, "the old owner joins the share list").toEqual([teamA]);

      // ── Owner stage (API), then the destination stage on the page. ──
      await page.request.post(`/api/proposals/${moveId}/actions`, { data: { action: "start_review" } });
      expect(await accept(page, moveId), "the owner's accept waits for the destination").toBe("awaiting_destination");
      expect((await page.request.get(`/api/skills/team-a/${slug}`)).ok(), "nothing has moved yet").toBeTruthy();

      await gotoLoaded(page, `/proposals/${moveId}`, `/api/proposals/${moveId}`);
      await expect(page.getByTestId("move-progress")).toContainText("approved by");
      await expect(page.getByTestId("move-progress")).toContainText("waiting");
      const acceptBtn = page.getByRole("button", { name: `Accept & move to @${DEST_SLUG}` });
      await expect(acceptBtn).toBeVisible();
      await clickAndAwait(page, () => acceptBtn.click(), `/api/proposals/${moveId}/actions`, { method: "POST" });
      home = DEST_SLUG;
      await expect.poll(async () => (await (await page.request.get(`/api/proposals/${moveId}`)).json()).state, { timeout: 15_000 }).toBe("accepted");

      // ── The skill lives at the new address; the old one still resolves and the page redirects. ──
      const moved = await page.request.get(`/api/skills/${DEST_SLUG}/${slug}`);
      expect(moved.ok(), await moved.text()).toBeTruthy();
      const viaOld = await page.request.get(`/api/skills/team-a/${slug}`);
      expect(viaOld.ok(), "the old API address resolves through the alias").toBeTruthy();
      const grants = ((await (await page.request.get(`/api/skills/${DEST_SLUG}/${slug}/grants`)).json()) as { grants: { namespaceId: string }[] }).grants.map((g) => g.namespaceId);
      expect(grants, "team-a keeps access as a grantee").toEqual([teamA]);
      await page.goto(`/skills/team-a/${slug}`);
      await expect(page).toHaveURL(new RegExp(`/skills/${DEST_SLUG}/${slug}$`), { timeout: 30_000 });
    } finally {
      await deleteSkillFully(page, home, slug);
    }
  });
});
