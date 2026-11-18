// e2e: deleting a namespace from the Administration → Namespaces card (SKILLY_SPEC.md §72.5). Runs
// against the dev stack (SKILLY_DEV_AUTH=1) as the seeded platform admin.
//
// Journey: a fresh namespace with one accepted skill → Delete lists the live skill as a blocker →
// the skill is archived → Delete now says the archived skill will be permanently deleted → the
// button stays disabled until the slug is typed → the delete removes the row from the card and the
// namespace from the API. The full effect matrix (re-homing, shares, marketplace, policy rules,
// audit, notifications, the slug hold) needs several identities and fixtures the UI can't build —
// namespaceDelete.dbtest.ts covers it against the DB.
//
// Self-cleaning: if the journey stops early, `finally` purges the skill and deletes the namespace
// through the API.
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";
import { awaitApi, clickAndAwait, gotoLoaded } from "./helpers/ready";
import type { Page } from "@playwright/test";

async function accept(page: Page, id: string): Promise<void> {
  await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } });
  const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
  const revisionNo: number = detail.revisions.at(-1).revisionNo;
  let r = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
  if (r.status() === 409 && (await r.json()).requiresOverride) {
    r = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo, override: true, overrideReason: "e2e fixture" } });
  }
  expect(r.ok(), await r.text()).toBeTruthy();
}

/** Open the Namespaces card (cards start collapsed) and narrow its list to the `slug` row. */
async function showNamespace(page: Page, slug: string): Promise<void> {
  await gotoLoaded(page, "/admin", "/api/admin/namespaces");
  const header = page.getByRole("button", { name: /^Namespaces/ }).first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  const search = page.getByRole("textbox", { name: "Search namespaces" });
  await expect(search).toBeVisible({ timeout: 20_000 });
  await Promise.all([awaitApi(page, /\/api\/admin\/namespaces\?.*q=/), search.fill(slug)]);
  await expect(page.locator("section.card").filter({ hasText: `@${slug}` }).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("§72 deleting a namespace", () => {
  test.describe.configure({ mode: "serial" });

  test("a live skill blocks the delete; once archived it is purged with the namespace", async ({ page }) => {
    test.setTimeout(240_000);
    await devSignIn(page);
    const slug = `e2e-nsdel-${Date.now().toString(36)}`;
    const skill = `${slug}-skill`;
    const created = await page.request.post("/api/admin/namespaces", { data: { slug, displayName: "E2E Doomed", requireReview: true } });
    expect(created.status(), await created.text()).toBe(201);
    const nsId = ((await created.json()) as { id: string }).id;
    let gone = false;

    try {
      const pid = await createHostedProposal(page, { namespaceSlug: slug, skillSlug: skill, title: "Doomed skill", visibility: "namespace" });
      await accept(page, pid);

      // ── 1. Blocked: the live skill is listed and linked; there is no Delete button. ──
      await showNamespace(page, slug);
      await clickAndAwait(page, () => page.getByTestId(`ns-delete-${slug}`).click(), `/api/admin/namespaces/${nsId}/deletion`);
      const dialog = page.getByTestId("ns-delete-dialog");
      const blocked = dialog.getByTestId("ns-delete-blocked");
      await expect(blocked).toBeVisible();
      await expect(blocked).toContainText("can’t be deleted yet");
      await expect(blocked.getByRole("link", { name: "Doomed skill" })).toHaveAttribute("href", `/skills/${slug}/${skill}`);
      await expect(dialog.getByTestId("ns-delete-confirm")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // ── 2. Archive the skill; the dialog is now Ready and names what will happen. ──
      const archived = await page.request.post(`/api/skills/${slug}/${skill}/archive`, { data: { archived: true } });
      expect(archived.ok(), await archived.text()).toBeTruthy();
      await clickAndAwait(page, () => page.getByTestId(`ns-delete-${slug}`).click(), `/api/admin/namespaces/${nsId}/deletion`);
      const ready = dialog.getByTestId("ns-delete-ready");
      await expect(ready).toBeVisible();
      await expect(ready).toContainText("is permanent");
      await expect(ready.getByTestId("ns-delete-effects")).toContainText("1 archived skill will be permanently deleted");
      await expect(ready.getByTestId("ns-delete-effects")).toContainText(skill);

      // ── 3. Delete stays disabled until the slug is typed exactly. ──
      const confirm = dialog.getByTestId("ns-delete-confirm");
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId("ns-delete-slug").fill(slug.toUpperCase());
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId("ns-delete-slug").fill(slug);
      await expect(confirm).toBeEnabled();
      await dialog.getByRole("textbox", { name: /Reason/ }).fill("e2e cleanup");
      await clickAndAwait(page, () => confirm.click(), `/api/admin/namespaces/${nsId}`, { method: "DELETE" });
      gone = true;

      // ── 4. The row leaves the card; the namespace and its skill are gone from the API. ──
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("ns-delete-notice")).toHaveText(`Deleted @${slug}.`);
      await expect(page.getByTestId(`ns-delete-${slug}`)).toHaveCount(0);
      const list = await (await page.request.get(`/api/admin/namespaces?list=1&q=${encodeURIComponent(slug)}`)).json();
      expect(list.namespacesTotal).toBe(0);
      expect((await page.request.get(`/api/skills/${slug}/${skill}`)).status()).toBe(404);
    } finally {
      if (!gone) {
        await deleteSkillFully(page, slug, skill);
        await page.request.delete(`/api/admin/namespaces/${nsId}`, { data: { confirmSlug: slug } });
      }
    }
  });

  test("global has no Delete button, and the API refuses it", async ({ page }) => {
    await devSignIn(page);
    const cfg = await (await page.request.get("/api/admin/namespaces?list=1&q=global")).json();
    const global = (cfg.namespaces as { id: string; slug: string }[]).find((n) => n.slug === "global");
    expect(global, "the global namespace exists").toBeTruthy();
    const r = await page.request.delete(`/api/admin/namespaces/${global!.id}`, { data: { confirmSlug: "global" } });
    expect(r.status()).toBe(422);
    expect((await r.json()).code).toBe("global_namespace");

    await showNamespace(page, "global");
    await expect(page.getByTestId("ns-delete-global")).toHaveCount(0);
  });
});
