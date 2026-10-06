// e2e: AI-drafted quality improvements (SKILLY_SPEC.md §43.12) and the AI display name (§40.14),
// against a local Open WebUI-shaped stub provider started in the test process. The dev user is a
// platform admin, so it may draft on any hosted skill.
//   1. With the display name set to "Aria", a low-scoring hosted skill's Quality card offers
//      "Draft improvements with Aria" and reads "Aria assessment"-style copy.
//   2. The dialog shows the plan → Generate → the stub's SKILL.md rewrite (with a diff) and the
//      README removal → untick the removal → Open in propose form.
//   3. The propose form carries the drafted bundle and the pre-filled note → Submit for review →
//      the proposal page shows "Drafted with Aria" and the improved rules score.
//
// Needs AI_TOKEN_ENC_KEY on the dev server (CI sets a fixed test key); skipped without it. Serial:
// the integration and the display name are platform-wide. Self-cleaning.
import AdmZip from "adm-zip";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { deleteSkillFully } from "./helpers/skills";
import { clickAndAwait, gotoLoaded, NAV_TIMEOUT } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const TOKEN = "owui-e2e-draft-token-4455";
const BETTER = (slug: string) =>
  `---\nname: ${slug}\ndescription: Reviews PDF contracts. Use this when the user says "review this contract". Do not use for spreadsheets.\n---\n\n# ${slug}\n\n## Instructions\n\n1. Read the contract.\n2. List the risky clauses.\n\n## Examples\n\nUser says: "review this contract"\n\n## Troubleshooting\n\nIf the PDF has no text layer, ask for a text copy.\n`;

let server: Server;
let stubUrl = "";
let slugForStub = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ detail: "invalid token" }));
        return;
      }
      if (req.url === "/api/models") {
        res.end(JSON.stringify({ data: [{ id: "stub-drafter" }] }));
        return;
      }
      const parsed = JSON.parse(body || "{}") as { model?: string; messages?: { role: string; content: string }[] };
      const user = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      let content = "OK";
      if (user.includes("## File: SKILL.md")) {
        content = JSON.stringify({ action: "modify", content: BETTER(slugForStub), summary: "Added triggers, steps, examples and troubleshooting", addressed: ["DS-001", "BD-004"] });
      } else if (user.includes("## File: README.md")) {
        content = JSON.stringify({ action: "delete", summary: "Documentation belongs in SKILL.md", addressed: ["FS-003"] });
      } else if (user.includes("## File:")) {
        content = JSON.stringify({ action: "keep", summary: "fine" });
      }
      res.end(JSON.stringify({ model: parsed.model ?? "stub-drafter", choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 9, completion_tokens: 9 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server?.close();
});

// Never leave AI enabled or the name changed: later specs (quality §41, the AI card §40) assume neither.
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/admin/ai").catch(() => {});
  await page.request.put("/api/admin/ai/display-name", { data: { displayName: "" } }).catch(() => {});
});

async function enableAi(page: Page): Promise<boolean> {
  await page.request.delete("/api/admin/ai");
  const st = await (await page.request.get("/api/admin/ai")).json();
  if (!st.keyConfigured) return false;
  const saved = await page.request.put("/api/admin/ai", { data: { provider: "openwebui", baseUrl: stubUrl, model: "stub-drafter", token: TOKEN } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const on = await page.request.patch("/api/admin/ai", { data: { enabled: true } });
  expect(on.ok(), await on.text()).toBeTruthy();
  return true;
}

async function publishLowQuality(page: Page, slug: string): Promise<void> {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(`---\nname: ${slug}\ndescription: Helps.\n---\n\n# ${slug}\n\nMake sure to do things properly. salt=${randomBytes(6).toString("hex")}\n`));
  zip.addFile("README.md", Buffer.from("# readme\n"));
  const up = await page.request.post("/api/uploads", { multipart: { bundle: { name: `${slug}.skill`, mimeType: "application/zip", buffer: zip.toBuffer() }, skillSlug: slug } });
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
  const id = (await res.json()).id as string;
  const detail = await (await page.request.get(`/api/proposals/${id}`)).json();
  expect((await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "start_review" } })).ok()).toBeTruthy();
  const acc = await page.request.post(`/api/proposals/${id}/actions`, { data: { action: "accept", revisionNo: detail.revisions.at(-1).revisionNo } });
  expect(acc.ok(), await acc.text()).toBeTruthy();
}

test("draft improvements with a branded AI: plan → generate → review → propose → Drafted with badge", async ({ page }) => {
  test.setTimeout(240_000);
  await devSignIn(page);
  test.skip(!(await enableAi(page)), "AI_TOKEN_ENC_KEY is not set on the dev server");
  const named = await page.request.put("/api/admin/ai/display-name", { data: { displayName: "Aria" } });
  expect(named.ok(), await named.text()).toBeTruthy();
  const me = await (await page.request.get("/api/me")).json();
  expect(me.aiDisplayName).toBe("Aria");

  const slug = `e2e-ai-draft-${Date.now().toString(36)}`;
  slugForStub = slug;
  try {
    await publishLowQuality(page, slug);
    const skill = await (await page.request.get(`/api/skills/global/${slug}`)).json();
    expect(skill.qualityDetail.aiDraft).toEqual({ available: true, reason: null });
    const before = skill.qualityDetail.rulesScore as number;

    // ── 1. The card offers the branded action. ──
    await gotoLoaded(page, `/skills/global/${slug}`, `/api/skills/global/${slug}`);
    const card = page.getByTestId("quality-card");
    await expect(card).toBeVisible({ timeout: NAV_TIMEOUT });
    const btn = card.getByTestId("quality-ai-draft");
    await expect(btn).toHaveText(/Draft improvements with Aria/);

    // ── 2. Plan → generate → results. ──
    await clickAndAwait(page, () => btn.click(), `/quality/draft/plan`);
    const dialog = page.getByTestId("ai-draft-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("ai-draft-plan-sent")).toContainText("SKILL.md");
    await expect(page.getByTestId("ai-draft-plan-sent")).toContainText("README.md");
    await page.getByTestId("ai-draft-generate").click();
    const skillRow = dialog.locator('[data-testid="ai-draft-file"][data-path="SKILL.md"]');
    const readmeRow = dialog.locator('[data-testid="ai-draft-file"][data-path="README.md"]');
    await expect(skillRow).toHaveAttribute("data-status", "modified", { timeout: NAV_TIMEOUT });
    await expect(readmeRow).toHaveAttribute("data-status", "deleted");
    await expect(skillRow).toContainText("Added triggers, steps, examples and troubleshooting");
    await skillRow.getByRole("button", { name: /diff/ }).click();
    await expect(skillRow.getByText("2. List the risky clauses.")).toBeVisible();
    // Keep the rewrite, drop the README removal.
    await readmeRow.getByTestId("ai-draft-include").uncheck();
    await expect(page.getByTestId("ai-draft-included")).toContainText("1 change included");

    // ── 3. The propose form carries the drafted bundle and the note. ──
    await clickAndAwait(page, () => page.getByTestId("ai-draft-open-propose").click(), `/quality/draft/assemble`, { method: "POST" });
    await page.waitForURL(/\/propose\?newVersion=1/, { timeout: NAV_TIMEOUT });
    await expect(page.getByTestId("ai-draft-notice")).toContainText("Files drafted with Aria from v1.0.0", { timeout: NAV_TIMEOUT });
    await expect(page.getByTestId("ai-draft-attached")).toBeVisible();
    await expect(page.locator("textarea").filter({ hasText: "SKILL.md: Added triggers" })).toBeVisible();
    const created = await clickAndAwait(page, () => page.getByRole("button", { name: "Submit for review →" }).click(), "/api/proposals", { method: "POST" });
    const proposalId = ((await created.json()) as { id: string }).id;
    await page.waitForURL(new RegExp(`/proposals/${proposalId}`), { timeout: NAV_TIMEOUT });
    await expect(page.getByTestId("ai-drafted-badge")).toHaveText(/Drafted with Aria/, { timeout: NAV_TIMEOUT });

    const proposal = await (await page.request.get(`/api/proposals/${proposalId}`)).json();
    expect(proposal.aiDraftModel).toBe("stub-drafter");
    expect(proposal.quality.rulesScore).toBeGreaterThan(before);
    // The README removal was unticked, so the bundle still carries it (FS-003 remains).
    expect(proposal.quality.findings.map((f: { rule: string }) => f.rule)).toContain("FS-003");
    expect(proposal.revisions.at(-1).payload.metadata.whatChanged).toContain("SKILL.md: Added triggers");
  } finally {
    await deleteSkillFully(page, "global", slug);
  }
});
