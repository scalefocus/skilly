// e2e: the §40 Administration "AI integration" card against a local Open WebUI-shaped stub
// provider (started in the test process; the dev server reaches it on 127.0.0.1). Covers: the card
// is collapsed by default; models load into the dropdown; Test passes; a Save with a bad token is
// rejected with the error shown and nothing saved; a good Save stores the token (shown only as
// "Set · ends …"); enabling flips the pill to Operational; Remove returns it to Not configured.
//
// Needs AI_TOKEN_ENC_KEY on the dev server (CI sets a fixed test key); skipped without it. Serial:
// the integration is one platform-wide row.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { acceptNextDialog, clickAndAwait, gotoLoaded } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const GOOD = "owui-e2e-good-token-7788";

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
        res.end(JSON.stringify({ detail: "Your session has expired or the token is invalid." }));
        return;
      }
      if (req.url === "/api/models") {
        res.end(JSON.stringify({ data: [{ id: "stub-llama" }, { id: "stub-gemma" }] }));
        return;
      }
      if (req.url === "/api/chat/completions") {
        const model = (JSON.parse(body) as { model: string }).model;
        res.end(JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 9, completion_tokens: 1 } }));
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

const card = (page: Page) => page.locator('[data-last-card="ai"]');
const header = (page: Page) => card(page).locator("[data-card-header]");

async function openCard(page: Page): Promise<boolean> {
  await devSignIn(page);
  // Clean slate: the integration is a single platform-wide row.
  await page.request.delete("/api/admin/ai");
  const res = page.waitForResponse((r) => r.url().endsWith("/api/admin/ai") && r.request().method() === "GET" && r.ok());
  await gotoLoaded(page, "/admin", "/api/admin/ai");
  const state = (await (await res).json()) as { keyConfigured: boolean };
  if (!state.keyConfigured) return false;
  await expect(header(page)).toHaveAttribute("aria-expanded", "false"); // collapsed by default
  await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-expanded", "true");
  return true;
}

// Never leave a configured (stub) integration behind, even when an assertion fails mid-test: later
// specs (e.g. quality, §41) behave differently while AI is enabled.
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/admin/ai").catch(() => {});
});

test("configure Open WebUI: models, test, rejected save, save, enable, remove", async ({ page }) => {
  test.skip(!(await openCard(page)), "AI_TOKEN_ENC_KEY is not set on the dev server");
  const c = card(page);
  await expect(header(page)).toContainText("Not configured");

  await c.getByRole("button", { name: "Open WebUI" }).click();
  await c.getByLabel(/^Base URL/).fill(stubUrl);
  await c.getByLabel("API key / bearer token").fill(GOOD);

  // Models load into the dropdown.
  await clickAndAwait(page, () => c.getByRole("button", { name: "Load models" }).click(), "/api/admin/ai/models", { method: "POST" });
  const modelSelect = c.locator("select#ai-model");
  await expect(modelSelect).toBeVisible();
  await modelSelect.selectOption("stub-llama");

  // Test passes.
  await clickAndAwait(page, () => c.getByRole("button", { name: "Test", exact: true }).click(), "/api/admin/ai/test", { method: "POST" });
  await expect(c.getByTestId("ai-test-result")).toContainText("Test passed");

  // A bad token: Save runs the test, fails, and nothing is saved.
  await c.getByLabel("API key / bearer token").fill("owui-e2e-wrong-0000");
  const rejected = page.waitForResponse((r) => r.url().endsWith("/api/admin/ai") && r.request().method() === "PUT");
  await c.getByRole("button", { name: "Save", exact: true }).click();
  expect((await rejected).status()).toBe(422);
  await expect(c.getByText(/Not saved — the test failed/)).toBeVisible();
  await expect(header(page)).toContainText("Not configured");

  // The good token: saved; the token now shows only as "Set · ends …7788".
  await c.getByLabel("API key / bearer token").fill(GOOD);
  await clickAndAwait(page, () => c.getByRole("button", { name: "Save", exact: true }).click(), "/api/admin/ai", { method: "PUT" });
  await expect(c.getByText("Saved — the test passed.")).toBeVisible();
  await expect(c.getByTestId("ai-token-set")).toHaveText("Set · ends …7788");
  await expect(header(page)).toContainText("Off");

  // Enable → Operational.
  const sw = c.getByRole("switch", { name: "AI integration enabled" });
  await expect(sw).toBeEnabled();
  await clickAndAwait(page, () => sw.click(), "/api/admin/ai", { method: "PATCH" });
  await expect(header(page)).toContainText("Operational");
  await expect(c.getByTestId("ai-usage")).toContainText("Test");
  // The egress notice lists every registered AI task (§40.4) — the first is the quality assessment (§41.5).
  await expect(c.locator('[data-testid="ai-feature"][data-feature="skill_quality"]')).toContainText("Skill quality assessment");
  await expect(c.getByTestId("ai-no-features")).toHaveCount(0);

  // Remove → Not configured.
  const dialog = acceptNextDialog(page);
  const removed = page.waitForResponse((r) => r.url().endsWith("/api/admin/ai") && r.request().method() === "DELETE");
  await c.getByRole("button", { name: "Remove integration" }).click();
  await dialog;
  expect((await removed).status()).toBe(204);
  await expect(header(page)).toContainText("Not configured");
});
