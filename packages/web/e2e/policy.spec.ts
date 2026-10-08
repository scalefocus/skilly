// e2e: policy rules — policy-as-prompt, judged in the §46 pre-review (SKILLY_SPEC.md §47.14). Runs against the dev stack
// (SKILLY_DEV_AUTH=1) as the seeded platform admin.
//
// Journey: a namespace admin writes an ENFORCED rule on the Namespace administration page → the
// propose form shows it in the "Policy rules (1)" panel once that namespace is picked → a hosted
// proposal there gets a Policy section → accepting needs the override, whose dialog names the rule
// → after an override-accept the skill page carries the policy chip.
//
// The e2e stack runs no worker, so no §46 run ever lands here: the proposal's check stays pending
// (or "unavailable" while the pre-review switch / AI integration is off) and the gate trips on "no verdict" —
// the fail-closed path (§47.7). Judged verdicts, evidence verification, notifications and the
// onset are covered by packages/worker/src/integration/policySweep.test.ts and policy.dbtest.ts.
//
// Rules apply to every proposal in their namespace, so the spec uses its own fixed namespace
// (`e2e-policy`, idempotently created — the dev stack has no namespace delete) and deletes its
// rule and skill in `finally`.
import { test, expect, devSignIn } from "./fixtures";
import { createHostedProposal, deleteSkillFully } from "./helpers/skills";
import { gotoReady, NAV_TIMEOUT } from "./helpers/ready";
import type { Page } from "@playwright/test";

const NS = "e2e-policy";

async function ensureNamespace(page: Page): Promise<void> {
  // 201 on first run, 422 ("already exists") afterwards — both fine.
  await page.request.post("/api/admin/namespaces", { data: { slug: NS, displayName: "E2E Policy", requireReview: true } });
}

async function deleteRules(page: Page): Promise<void> {
  const res = await page.request.get(`/api/policy/rules?ns=${NS}&all=1`);
  if (!res.ok()) return;
  for (const r of ((await res.json()).namespace ?? []) as { id: string }[]) {
    // An uncited rule deletes; a cited one (never the case without a worker) is disabled instead.
    const del = await page.request.delete(`/api/policy/rules/${r.id}`);
    if (del.status() === 409) await page.request.put(`/api/policy/rules/${r.id}/state`, { data: { state: "disabled" } });
  }
}

test.describe.serial("policy rules (§47)", () => {
  test("an enforced rule is shown to authors, gates the accept, and marks the published skill", async ({ page }) => {
    test.setTimeout(360_000);
    await devSignIn(page);
    await ensureNamespace(page);
    await deleteRules(page);
    const title = `No external APIs ${Date.now().toString(36)}`;
    const slug = `e2e-policy-${Date.now().toString(36)}`;

    try {
      // ── 1. Write the rule on the Namespace administration page, enforced from the start. ──
      await gotoReady(page, "/namespaces");
      const card = page.locator("[data-last-card]").filter({ hasText: `@${NS}` });
      await expect(card).toBeVisible({ timeout: NAV_TIMEOUT });
      await card.getByTestId("ns-policy-rules").locator("summary").click();
      const editor = card.getByTestId("policy-rules-editor");
      await expect(editor).toBeVisible({ timeout: NAV_TIMEOUT });
      await editor.getByTestId("policy-add-rule").click();
      await editor.getByLabel("Title").fill(title);
      await editor.getByLabel("Rule").fill("No skill may call an external HTTP API except through an approved adapter.");
      await editor.getByLabel("Context for the pre-reviewer").fill("Approved adapters: the acme-http skill.");
      await editor.getByLabel("Initial state").selectOption("enforced");
      await editor.getByRole("button", { name: "Add rule" }).click();
      const row = editor.locator(`[data-testid="policy-rule-row"][data-rule="${title}"]`);
      await expect(row).toHaveAttribute("data-state", "enforced", { timeout: NAV_TIMEOUT });

      // Every signed-in user can read it (§47.1 #5).
      const listing = await (await page.request.get(`/api/policy/rules?ns=${NS}`)).json();
      expect(listing.namespace.map((r: { title: string }) => r.title)).toContain(title);

      // ── 2. The propose form shows the rule once the namespace is picked. ──
      await gotoReady(page, "/propose");
      const nsSelect = page.locator("select").filter({ has: page.locator(`option[value="${NS}"]`) }).first();
      await expect(nsSelect).toBeVisible({ timeout: NAV_TIMEOUT });
      await nsSelect.selectOption(NS);
      const panel = page.getByTestId("policy-rules-panel");
      await expect(panel).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(panel.locator("summary")).toHaveText(/Policy rules \(\d+\)/);
      await panel.locator("summary").click();
      await expect(panel.getByText(title)).toBeVisible();

      // ── 3. A proposal there gets a Policy section; with no worker the check never lands. ──
      const id = await createHostedProposal(page, { namespaceSlug: NS, skillSlug: slug, title: "E2E Policy" });
      await gotoReady(page, `/proposals/${id}`);
      const section = page.getByTestId("policy-section");
      await expect(section).toBeVisible({ timeout: NAV_TIMEOUT });
      // No worker in the e2e stack: the §46 run never lands — pending, or off / unavailable when the
      // pre-review switch or the AI integration is off (the usual case here).
      await expect(section).toHaveAttribute("data-status", /^(pending|off|unavailable|skipped)$/);
      await expect(section.getByTestId("policy-status-line")).toContainText(/Policy check (pending|unavailable|skipped)/);

      // ── 4. Accepting needs the override; the decision area names the rule. ──
      expect((await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } })).ok()).toBeTruthy();
      await gotoReady(page, `/proposals/${id}`);
      const override = page.getByTestId("accept-override");
      await expect(override).toBeVisible({ timeout: NAV_TIMEOUT });
      await expect(override.getByTestId("policy-override-list")).toContainText(title);
      await expect(page.getByRole("button", { name: "Accept & publish" })).toBeDisabled();

      const revisionNo: number = (await (await page.request.get(`/api/proposals/${id}`)).json()).revisions.at(-1).revisionNo;
      const blocked = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo } });
      expect(blocked.status()).toBe(409);
      const blockedBody = await blocked.json();
      expect(blockedBody.requiresOverride).toBe(true);
      expect(blockedBody.policy.tripped.map((t: { title: string }) => t.title)).toContain(title);

      // The UI path: tick the override, give the reason, accept.
      await page.getByPlaceholder(/Note \/ reason/).fill("e2e: reviewed by hand");
      await override.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Accept & publish" }).click();
      // The page reloads into the accepted state (the Decision area goes away), so check the state.
      await expect
        .poll(async () => (await (await page.request.get(`/api/proposals/${id}`)).json()).state, { timeout: NAV_TIMEOUT })
        .toBe("accepted");

      // ── 5. The skill page carries the chip; the owner card explains the pending check. ──
      const skill = await (await page.request.get(`/api/skills/${NS}/${slug}`)).json();
      expect(skill.policy.status).toBe("pending");
      expect(skill.policy).not.toHaveProperty("results");
      await gotoReady(page, `/skills/${NS}/${slug}`);
      await expect(page.getByTestId("policy-chip")).toHaveText("Policy check pending", { timeout: NAV_TIMEOUT });
      const policyCard = page.getByTestId("policy-card");
      await policyCard.getByRole("button", { name: /Policy/ }).first().click();
      await expect(policyCard.getByTestId("policy-card-pending")).toBeVisible({ timeout: NAV_TIMEOUT });
    } finally {
      await deleteSkillFully(page, NS, slug);
      await deleteRules(page);
    }
  });
});
