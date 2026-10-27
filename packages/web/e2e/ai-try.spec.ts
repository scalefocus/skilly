// e2e: Try a skill before installing (SKILLY_SPEC.md §61.13) against a local Open WebUI-shaped stub
// provider (started in the test process; the dev server reaches it on 127.0.0.1). With AI enabled
// and the Try switch on: the seeded global/pdf-tools page offers "Try with AI" → the panel shows the
// disclosure and the skill's Usage → a message gets the stub's reply → after a reload the
// conversation is still there → Start over clears it. With the switch off the button is absent.
//
// Needs AI_TOKEN_ENC_KEY on the dev server (CI sets a fixed test key); skipped without it. Serial and
// exclusive: the integration and the switch are platform-wide, and both are reset afterwards.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { aiSaveSkipReason } from "./helpers/ai";
import { acceptNextDialog, awaitApi, clickAndAwait, gotoLoaded, NAV_TIMEOUT, reloadReady } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const GOOD = "owui-e2e-try-token-4471";
const REPLY = "TRY_STUB_REPLY: I would read the PDF and list its pages.";
const SKILL = "/skills/global/pdf-tools";
const DETAIL = "/api/skills/global/pdf-tools";

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
        // The §61.4 system prompt loads the skill; the connectivity test does not.
        const content = body.includes("Agent Skill below loaded") ? REPLY : "OK";
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

// Never leave the switch on or a configured (stub) integration behind: later specs behave differently.
test.afterEach(async ({ page }) => {
  await page.request.put("/api/admin/ai/try", { data: { enabled: false } }).catch(() => {});
  await page.request.delete("/api/admin/ai").catch(() => {});
});

/** Save + enable the stub integration through the admin API; the skip reason when the dev server cannot take it. */
async function enableAi(page: Page): Promise<string | null> {
  const saved = await page.request.put("/api/admin/ai", { data: { provider: "openwebui", baseUrl: stubUrl, model: "stub-llama", token: GOOD } });
  const reason = await aiSaveSkipReason(saved);
  if (reason) return reason;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect((await page.request.patch("/api/admin/ai", { data: { enabled: true } })).ok()).toBeTruthy();
  return null;
}

const tryButton = (page: Page) => page.getByTestId("try-button");
const panel = (page: Page) => page.getByTestId("try-panel");

test("try a skill: disclosure, Usage, a reply, kept across a reload, Start over; hidden with the switch off", async ({ page }) => {
  // The first open compiles the Try route and the panel under `next dev`.
  test.setTimeout(180_000);
  await devSignIn(page);
  await page.request.delete("/api/admin/ai");
  const skip = await enableAi(page);
  if (skip) test.skip(true, skip);
  expect((await page.request.put("/api/admin/ai/try", { data: { enabled: true } })).ok()).toBeTruthy();
  const detail = await (await page.request.get(DETAIL)).json();
  expect(detail.tryAvailable, "the seeded pdf-tools must be installable").toBe(true);

  await gotoLoaded(page, SKILL, DETAIL);
  await expect(tryButton(page)).toHaveText("Try with AI", { timeout: NAV_TIMEOUT });

  // Open: the version resolves and the header fills.
  await clickAndAwait(page, () => tryButton(page).click(), "/api/skills/global/pdf-tools/try");
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("try-version")).toHaveText(`v${detail.latestInstallable}`);
  const disclosure = page.getByTestId("try-disclosure");
  await expect(disclosure).toContainText("Preview on stub-llama");
  await expect(disclosure).toContainText("Messages you type are sent to AI");
  await expect(page.getByTestId("try-loaded")).toContainText("Loaded SKILL.md");
  await expect(page.getByTestId("try-empty")).toBeVisible();

  // A message gets the stub's reply.
  await page.getByTestId("try-input").fill("Split this PDF into pages");
  const sent = awaitApi(page, "/api/skills/global/pdf-tools/try", { method: "POST" });
  await page.getByTestId("try-send").click();
  expect((await sent).status()).toBe(200);
  const assistant = page.locator('[data-testid="try-message"][data-role="assistant"]');
  await expect(assistant).toContainText("TRY_STUB_REPLY");
  await expect(page.locator('[data-testid="try-message"][data-role="user"]')).toHaveText("Split this PDF into pages");

  // The conversation survives a reload in the same tab.
  await reloadReady(page);
  await clickAndAwait(page, () => tryButton(page).click(), "/api/skills/global/pdf-tools/try");
  await expect(page.getByTestId("try-message")).toHaveCount(2);

  // Start over clears it (after a confirm) and puts focus in the composer: the button goes disabled,
  // which would otherwise drop focus to <body>.
  const confirmed = acceptNextDialog(page);
  await page.getByTestId("try-start-over").click();
  await confirmed;
  await expect(page.getByTestId("try-message")).toHaveCount(0);
  await expect(page.getByTestId("try-empty")).toBeVisible();
  await expect(page.getByTestId("try-start-over")).toBeDisabled();
  await expect(page.getByTestId("try-input")).toBeFocused();
  // Esc closes the panel even with focus fallen out of it (§33's shared Modal).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.getByTestId("try-input")).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  // Switch off → the button is not rendered at all.
  expect((await page.request.put("/api/admin/ai/try", { data: { enabled: false } })).ok()).toBeTruthy();
  await gotoLoaded(page, SKILL, DETAIL);
  await expect(page.getByRole("heading", { name: "Install", exact: true })).toBeVisible();
  await expect(tryButton(page)).toHaveCount(0);
});
