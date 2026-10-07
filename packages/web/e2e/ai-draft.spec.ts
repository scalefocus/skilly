// e2e: "Draft with AI" on the propose form (SKILLY_SPEC.md §43.12) against a local Open WebUI-shaped
// stub provider (started in the test process; the dev server reaches it on 127.0.0.1). Covers: with
// AI enabled, attaching a bundle → Draft with AI fills Description, Usage and categories (an invented
// category carries the "new" badge) → Undo restores the previous state; with text already typed the
// confirm dialog appears and "Fill empty fields only" keeps it; with AI removed the button is absent.
//
// Needs AI_TOKEN_ENC_KEY on the dev server (CI sets a fixed test key); skipped without it. Serial:
// the integration is one platform-wide row, and it is always removed afterwards.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AdmZip from "adm-zip";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { awaitApi, gotoLoaded } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const GOOD = "owui-e2e-draft-token-5511";
const NEW_CAT = `e2e draft ${Date.now().toString(36)}`;
const DRAFT = {
  description: "Reviews PDF contracts and flags risky clauses.",
  usage: "Ask it to \"review this contract\".\n\n- \"summarize clause 4\"\n- \"flag indemnities\"",
  categories: [NEW_CAT],
};

let server: Server;
let stubUrl = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${GOOD}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ detail: "invalid token" }));
        return;
      }
      if (req.url === "/api/models") {
        res.end(JSON.stringify({ data: [{ id: "stub-llama" }] }));
        return;
      }
      if (req.url === "/api/chat/completions") {
        // The §43 draft prompt carries the delimited SKILL.md; the connectivity test does not.
        const content = body.includes("SKILL_MD") ? JSON.stringify(DRAFT) : "OK";
        res.end(JSON.stringify({ model: "stub-llama", choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server?.close();
});

// Never leave a configured (stub) integration behind: later specs behave differently with AI on.
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/admin/ai").catch(() => {});
});

/** Save + enable the stub integration through the admin API; false when the dev server has no AI key. */
async function enableAi(page: Page): Promise<boolean> {
  const saved = await page.request.put("/api/admin/ai", { data: { provider: "openwebui", baseUrl: stubUrl, model: "stub-llama", token: GOOD } });
  if (saved.status() === 409) return false; // ai_key_missing
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect((await page.request.patch("/api/admin/ai", { data: { enabled: true } })).ok()).toBeTruthy();
  return true;
}

function bundle(): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from("---\nname: draft-me\ndescription: Use when the user asks to review a PDF contract.\n---\n# Contract review\n\n1. Read the PDF.\n"));
  return zip.toBuffer();
}

const description = (page: Page) => page.getByPlaceholder("What does this skill do?");
const usage = (page: Page) => page.getByPlaceholder(/^Shown as a quick-start/);
const draftButton = (page: Page) => page.getByRole("button", { name: "Draft with AI" });
const newChip = (page: Page) => page.locator(".taginput-chip", { hasText: NEW_CAT });

async function attachBundle(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Hosted upload" }).click();
  await page.locator('input[type="file"][accept*=".skill"]').setInputFiles({ name: "draft-me.skill", mimeType: "application/zip", buffer: bundle() });
}

test("draft fills description, usage and categories; undo; fill-empty-only; hidden when AI is off", async ({ page }) => {
  // The first draft compiles the propose page's draft path and the route under `next dev`.
  test.setTimeout(180_000);
  await devSignIn(page);
  await page.request.delete("/api/admin/ai");
  test.skip(!(await enableAi(page)), "AI_TOKEN_ENC_KEY is not set on the dev server");

  await gotoLoaded(page, "/propose", "/api/propose/ai-draft");
  await expect(draftButton(page)).toBeVisible();
  await expect(draftButton(page)).toBeDisabled(); // no source yet
  await attachBundle(page);
  await expect(draftButton(page)).toBeEnabled();

  // Empty fields → no dialog; the draft fills all three.
  const drafted = awaitApi(page, "/api/propose/ai-draft", { method: "POST" });
  await draftButton(page).click();
  await drafted;
  await expect(description(page)).toHaveValue(DRAFT.description);
  await expect(usage(page)).toHaveValue(DRAFT.usage);
  await expect(newChip(page)).toBeVisible();
  await expect(newChip(page).locator(".taginput-badge")).toHaveText("new");

  // Undo restores the pre-draft state.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(description(page)).toHaveValue("");
  await expect(usage(page)).toHaveValue("");
  await expect(newChip(page)).toHaveCount(0);

  // Typed text → confirm first; "Fill empty fields only" keeps it and fills Usage.
  await description(page).fill("My own description");
  await draftButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Replace your text?" });
  await expect(dialog).toBeVisible();
  const again = awaitApi(page, "/api/propose/ai-draft", { method: "POST" });
  await dialog.getByRole("button", { name: "Fill empty fields only" }).click();
  await again;
  await expect(description(page)).toHaveValue("My own description");
  await expect(usage(page)).toHaveValue(DRAFT.usage);
  await expect(newChip(page)).toBeVisible();

  // AI removed → the button is not rendered at all.
  expect((await page.request.delete("/api/admin/ai")).ok()).toBeTruthy();
  await gotoLoaded(page, "/propose", "/api/propose/ai-draft");
  await expect(page.getByPlaceholder("What does this skill do?")).toBeVisible();
  await expect(draftButton(page)).toHaveCount(0);
});
