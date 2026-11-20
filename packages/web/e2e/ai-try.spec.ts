// e2e: Try a skill before installing (SKILLY_SPEC.md §61.13) against a local Open WebUI-shaped stub
// provider (started in the test process; the dev server reaches it on 127.0.0.1). With AI enabled
// and the Try switch on: the seeded global/pdf-tools page offers "Try with AI" → the panel shows the
// disclosure and the skill's Usage → a message gets the stub's reply → after a reload the
// conversation is still there → Start over clears it. With the switch off the button is absent.
// The panel header shows the daily allowance, which drops by one with the reply.
// And the §40.18 Try limits row: the worst-case line follows the fields, an out-of-range value is
// refused beneath its field, *Messages per conversation* = 1 persists across a reload and ends the
// conversation after one message, and Reset to defaults → Save brings the placeholders back.
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
const TRY_API = "/api/skills/global/pdf-tools/try";
const LIMITS_API = "/api/admin/ai/try-limits";
/** Every Try limit back at its default (§40.18). */
const NO_LIMITS = { dailyCap: null, perMinute: null, maxTurns: null, maxMessageChars: null, maxTranscriptChars: null };

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

// Never leave the switch on, changed limits or a configured (stub) integration behind: later specs
// behave differently.
test.afterEach(async ({ page }) => {
  await page.request.put("/api/admin/ai/try", { data: { enabled: false } }).catch(() => {});
  await page.request.put(LIMITS_API, { data: NO_LIMITS }).catch(() => {});
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
/** The header's "N of M messages left today" line (§61.3). */
const dailyLine = (page: Page) => page.getByTestId("try-daily");
/** N from that line. A retry, or an earlier run against the same database, starts below the cap. */
const messagesLeft = async (page: Page) => Number((await dailyLine(page).innerText()).split(" ")[0]);
const aiCard = (page: Page) => page.locator('[data-last-card="ai"]');
const aiCardHeader = (page: Page) => aiCard(page).locator("[data-card-header]");

test("try a skill: disclosure, Usage, a reply, kept across a reload, Start over; hidden with the switch off", async ({ page }) => {
  // The first open compiles the Try route and the panel under `next dev`.
  test.setTimeout(180_000);
  await devSignIn(page);
  await page.request.delete("/api/admin/ai");
  await page.request.put(LIMITS_API, { data: NO_LIMITS });
  const skip = await enableAi(page);
  if (skip) test.skip(true, skip);
  expect((await page.request.put("/api/admin/ai/try", { data: { enabled: true } })).ok()).toBeTruthy();
  const detail = await (await page.request.get(DETAIL)).json();
  expect(detail.tryAvailable, "the seeded pdf-tools must be installable").toBe(true);

  await gotoLoaded(page, SKILL, DETAIL);
  await expect(tryButton(page)).toHaveText("Try with AI", { timeout: NAV_TIMEOUT });

  // Open: the version resolves and the header fills.
  await clickAndAwait(page, () => tryButton(page).click(), TRY_API);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("try-version")).toHaveText(`v${detail.latestInstallable}`);
  const disclosure = page.getByTestId("try-disclosure");
  await expect(disclosure).toContainText("Preview on stub-llama");
  await expect(disclosure).toContainText("Messages you type are sent to AI");
  await expect(page.getByTestId("try-loaded")).toContainText("Loaded SKILL.md");
  await expect(page.getByTestId("try-empty")).toBeVisible();
  // The daily allowance is always shown ("100 of 100 messages left today" on a fresh stack).
  await expect(dailyLine(page)).toHaveText(/^\d+ of 100 messages left today$/);
  const left = await messagesLeft(page);
  // The per-conversation countdown stays hidden until 5 or fewer remain.
  await expect(page.getByTestId("try-left")).toHaveCount(0);

  // A message gets the stub's reply, and the allowance drops by one.
  await page.getByTestId("try-input").fill("Split this PDF into pages");
  const sent = awaitApi(page, TRY_API, { method: "POST" });
  await page.getByTestId("try-send").click();
  expect((await sent).status()).toBe(200);
  const assistant = page.locator('[data-testid="try-message"][data-role="assistant"]');
  await expect(assistant).toContainText("TRY_STUB_REPLY");
  await expect(page.locator('[data-testid="try-message"][data-role="user"]')).toHaveText("Split this PDF into pages");
  await expect(dailyLine(page)).toHaveText(`${left - 1} of 100 messages left today`);

  // The conversation survives a reload in the same tab.
  await reloadReady(page);
  await clickAndAwait(page, () => tryButton(page).click(), TRY_API);
  await expect(page.getByTestId("try-message")).toHaveCount(2);
  await expect(dailyLine(page)).toHaveText(`${left - 1} of 100 messages left today`);

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

test("try limits: the worst-case line, a refused value, one message per conversation, reset to defaults", async ({ page }) => {
  // The first open compiles /admin, the limits route and the Try panel under `next dev`.
  test.setTimeout(180_000);
  await devSignIn(page);
  await page.request.delete("/api/admin/ai");
  await page.request.put(LIMITS_API, { data: NO_LIMITS });
  const skip = await enableAi(page);
  if (skip) test.skip(true, skip);
  expect((await page.request.put("/api/admin/ai/try", { data: { enabled: true } })).ok()).toBeTruthy();

  const openCard = async () => {
    await gotoLoaded(page, "/admin", "/api/admin/ai");
    if ((await aiCardHeader(page).getAttribute("aria-expanded")) !== "true") await aiCardHeader(page).click();
    await expect(aiCardHeader(page)).toHaveAttribute("aria-expanded", "true");
  };
  await openCard();
  const row = aiCard(page).getByTestId("ai-try-limits");
  const turns = row.getByTestId("ai-try-limit-maxTurns");
  const daily = row.getByTestId("ai-try-limit-dailyCap");
  const save = row.getByTestId("ai-try-limits-save");
  const worst = row.getByTestId("ai-try-limits-worst");
  await expect(turns).toHaveValue("");
  await expect(turns).toHaveAttribute("placeholder", "20");
  await expect(daily).toHaveAttribute("placeholder", "100");
  await expect(save).toBeDisabled(); // nothing to save yet
  await expect(worst).toContainText("Worst case: about 7.5 million input tokens per person per day.");
  await expect(worst).not.toContainText("With the defaults");

  // The worst case follows the fields as the admin types; an invalid value hides it and is refused
  // beneath its field, before any request.
  await daily.fill("1000");
  await expect(worst).toContainText("Worst case: about 75 million input tokens per person per day.");
  await expect(worst).toContainText("With the defaults: about 7.5 million.");
  await daily.fill("1001");
  await expect(worst).toHaveCount(0);
  await save.click();
  await expect(row.getByTestId("ai-try-limit-dailyCap-error")).toContainText("whole number from 1 to 1,000");
  await daily.fill("");
  await expect(row.getByTestId("ai-try-limit-dailyCap-error")).toHaveCount(0);
  // The API refuses it too, naming the field.
  const refused = await page.request.put(LIMITS_API, { data: { ...NO_LIMITS, perMinute: 61 } });
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({ error: "invalid_try_limit", field: "perMinute" });

  // One message per conversation: saved, and still there after a reload.
  await turns.fill("1");
  await clickAndAwait(page, () => save.click(), LIMITS_API, { method: "PUT" });
  await expect(row.getByTestId("ai-try-limits-msg")).toContainText("Saved");
  await openCard();
  await expect(turns).toHaveValue("1");
  await expect(worst).toContainText("about 7.5 million");

  // In the panel the change applies to the next message: one is allowed, then the conversation is full.
  await gotoLoaded(page, SKILL, DETAIL);
  await clickAndAwait(page, () => tryButton(page).click(), TRY_API);
  await expect(dailyLine(page)).toHaveText(/^\d+ of 100 messages left today$/);
  const left = await messagesLeft(page);
  await expect(page.getByTestId("try-left")).toHaveText("1 of 1 messages left in this conversation");
  await page.getByTestId("try-input").fill("Split this PDF into pages");
  const sent = awaitApi(page, TRY_API, { method: "POST" });
  await page.getByTestId("try-send").click();
  expect((await sent).status()).toBe(200);
  await expect(page.locator('[data-testid="try-message"][data-role="assistant"]')).toContainText("TRY_STUB_REPLY");
  await expect(dailyLine(page)).toHaveText(`${left - 1} of 100 messages left today`);
  await expect(page.getByTestId("try-full")).toContainText("This conversation is full. Start over to keep trying.");
  await expect(page.getByTestId("try-input")).toHaveCount(0);

  // Reset to defaults → Save → the override is gone and the placeholders show again.
  await openCard();
  await row.getByTestId("ai-try-limits-reset").click();
  await expect(turns).toHaveValue("");
  await clickAndAwait(page, () => save.click(), LIMITS_API, { method: "PUT" });
  const st = (await (await page.request.get("/api/admin/ai")).json()) as { tryLimits: Record<string, { override: number | null; effective: number }> };
  expect(Object.values(st.tryLimits).every((f) => f.override === null)).toBeTruthy();
  expect(st.tryLimits.maxTurns!.effective).toBe(20);
  await openCard();
  await expect(turns).toHaveValue("");
  await expect(turns).toHaveAttribute("placeholder", "20");
});
