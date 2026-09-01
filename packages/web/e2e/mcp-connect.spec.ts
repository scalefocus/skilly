// e2e: the §29 MCP connect flow — Dynamic Client Registration → authorize → consent → a
// single-use authorization code, plus the /mcp page and the admin card.
//
// DOCUMENTED BOUNDARY: the token endpoint and the MCP endpoint itself live on the WORKER (§29
// "Shape & placement"), and this suite runs against the web dev server only. So this spec covers
// everything web owns — registration, the consent screen's contents and both of its outcomes, the
// Connections list, and revocation — and stops at the redirect carrying the code. The worker half
// (code exchange, PKCE verification, refresh rotation, reuse detection, every tool and resource
// read) is covered by the worker's own integration suites (packages/worker/src/mcp/*.test.ts).
import { test, expect, devSignIn } from "./fixtures";

const REDIRECT = "http://127.0.0.1:8976/callback";
// A fixed, valid PKCE pair — S256 is mandatory (OAuth 2.1) and the challenge is checked on the
// worker, so the e2e only needs a well-formed one.
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function registerClient(page: import("@playwright/test").Page, name = "e2e MCP client") {
  const res = await page.request.post("/oauth/register", {
    data: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
}

function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "e2e-state",
    ...extra,
  });
  return `/oauth/authorize?${p.toString()}`;
}

test.describe("MCP connect flow (§29)", () => {
  test("registration is open, issues a public client, and never returns a secret", async ({ page }) => {
    const client = await registerClient(page);
    expect(client.client_id).toMatch(/^mcp_/);
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client).not.toHaveProperty("client_secret");
  });

  test("registration refuses a confidential client and a non-loopback http redirect", async ({ page }) => {
    const secret = await page.request.post("/oauth/register", {
      data: { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
    });
    expect(secret.status()).toBe(400);

    const badRedirect = await page.request.post("/oauth/register", {
      data: { redirect_uris: ["http://evil.example.com/cb"] },
    });
    expect(badRedirect.status()).toBe(400);
  });

  test("the consent screen names the client and states what it can and cannot do", async ({ page }) => {
    await devSignIn(page);
    const client = await registerClient(page, "Consent Screen Client");
    await page.goto(authorizeUrl(client.client_id));

    await expect(page.getByRole("heading", { name: /Connect Consent Screen Client to skilly/ })).toBeVisible();
    // The boundaries a user is agreeing to must be on the screen, not just in the docs.
    await expect(page.getByText(/approve or reject proposals/)).toBeVisible();
    await expect(page.getByText(/administer the platform/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
  });

  test("an unverifiable client_id or redirect_uri renders an error — it never redirects", async ({ page }) => {
    await devSignIn(page);
    await page.goto(authorizeUrl("mcp_does_not_exist"));
    await expect(page.getByRole("heading", { name: /isn.t valid/ })).toBeVisible();
    expect(page.url()).toContain("/oauth/authorize");

    const client = await registerClient(page, "Redirect Mismatch Client");
    await page.goto(`${authorizeUrl(client.client_id)}&redirect_uri=${encodeURIComponent("https://evil.example.com/cb")}`);
    await expect(page.getByText(/does not match this client/)).toBeVisible();
    expect(page.url()).not.toContain("evil.example.com");
  });

  test("a missing PKCE challenge is refused as a protocol error back to the client", async ({ page }) => {
    await devSignIn(page);
    const client = await registerClient(page, "No PKCE Client");
    const p = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "s",
    });
    // The redirect_uri IS verified here, so the error goes back to the client the normal way.
    const res = await page.request.get(`/oauth/authorize?${p.toString()}`, { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(res.status());
    expect(res.headers().location).toContain("error=invalid_request");
  });

  test("approving mints a code and lists the connection; revoking removes it", async ({ page }) => {
    await devSignIn(page);
    const client = await registerClient(page, "Approve Then Revoke Client");
    await page.goto(authorizeUrl(client.client_id));

    // The loopback redirect won't resolve — that's fine, we only need the URL the browser was sent to.
    const [nav] = await Promise.all([
      page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 15_000 }).catch(() => null),
      page.getByRole("button", { name: "Approve" }).click(),
    ]);
    const landed = nav?.url() ?? page.url();
    expect(landed).toContain("code=");
    expect(landed).toContain("state=e2e-state");
    // RFC 9207: the issuer is echoed so the client can bind the response.
    expect(landed).toContain("iss=");

    // The grant now shows on the MCP page, and can be revoked from there.
    const list = await (await page.request.get("/api/mcp/connections")).json();
    const conn = (list.connections as Array<{ grantId: string; clientName: string }>).find(
      (c) => c.clientName === "Approve Then Revoke Client",
    );
    expect(conn, JSON.stringify(list)).toBeTruthy();

    await page.goto("/mcp");
    await expect(page.getByRole("heading", { name: "MCP server" })).toBeVisible();
    await expect(page.getByText("Approve Then Revoke Client")).toBeVisible();
    // No credential is ever shown in a connect snippet — that's the point of the OAuth flow.
    await expect(page.getByText("x-access-token")).toHaveCount(0);

    const del = await page.request.delete(`/api/mcp/connections/${conn!.grantId}`);
    expect(del.ok(), await del.text()).toBeTruthy();
    const after = await (await page.request.get("/api/mcp/connections")).json();
    expect(
      (after.connections as Array<{ grantId: string }>).some((c) => c.grantId === conn!.grantId),
    ).toBeFalsy();
  });

  test("declining sends access_denied back to the client and creates no connection", async ({ page }) => {
    await devSignIn(page);
    const client = await registerClient(page, "Declining Client");
    await page.goto(authorizeUrl(client.client_id));

    const [nav] = await Promise.all([
      page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 15_000 }).catch(() => null),
      page.getByRole("button", { name: "Decline" }).click(),
    ]);
    expect(nav?.url() ?? page.url()).toContain("error=access_denied");

    const list = await (await page.request.get("/api/mcp/connections")).json();
    expect(
      (list.connections as Array<{ clientName: string }>).some((c) => c.clientName === "Declining Client"),
    ).toBeFalsy();
  });

  test("the MCP page shows the server URL and the connect snippets", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/mcp");
    // The copy affordance is the box itself, named per field (§29) — not a "Copy" button beside it.
    // Neither box renders until the server URL has loaded, and a cold `next dev` route compile can
    // outlast the default expect timeout, so the first wait is explicit.
    const code = page.getByRole("button", { name: "Copy the Claude Code command" });
    await expect(code).toBeVisible({ timeout: 30_000 });
    // Asserted WITH the URL: a bare `getByText("claude mcp add …")` also matches the truncated
    // command the page used to render mid-fetch, so it proved nothing about the URL being there.
    await expect(code).toHaveText(/^claude mcp add --transport http skilly https?:\/\/\S+$/);

    const json = page.getByRole("button", { name: "Copy the mcp.json configuration" });
    await expect(json).toBeVisible();
    await expect(json).toContainText('"mcpServers"');
    await expect(json).toContainText(/"url": "https?:\/\/\S+"/);
  });

  // §29: clicking anywhere in a connect snippet copies the whole thing, the same UX as §23's
  // install-command row. Clipboard permissions are Chromium-only — the suite's only project.
  test("clicking either connect snippet copies it to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await devSignIn(page);
    await page.goto("/mcp");

    await page.getByRole("button", { name: "Copy the Claude Code command" }).click();
    await expect(page.getByRole("status")).toHaveText("✓ Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^claude mcp add --transport http skilly https?:\/\/\S+$/,
    );

    await page.getByRole("button", { name: "Copy the mcp.json configuration" }).click();
    const json = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(json)).toMatchObject({ mcpServers: { skilly: { type: "http" } } });
  });

  // §29: the pill is a sibling of the scrolling box, not a child, so "click the field" and "click
  // the button" only behave identically because the interactive attributes sit on the wrapper.
  // Clicking the pill directly is the case that regresses silently if that ever moves.
  test("clicking the copy pill itself copies, not just the field", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await devSignIn(page);
    await page.goto("/mcp");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));

    const box = page.getByRole("button", { name: "Copy the Claude Code command" });
    await box.waitFor({ timeout: 30_000 });
    // Click the pill's own centre — not the box's.
    const pill = await box.evaluate((el) => {
      const r = el.querySelector("span.btn")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(pill.x, pill.y);
    await expect(page.getByRole("status")).toHaveText("✓ Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^claude mcp add --transport http skilly https?:\/\/\S+$/,
    );
  });

  // §29: a drag-select inside a snippet must NOT be hijacked into a full copy — the click event
  // that follows mouseup sees a live selection and is ignored, so a user grabbing just the URL out
  // of the mcp.json block keeps both their selection and their clipboard. This also guards the
  // `display:block` override: text inside a flex container is not drag-selectable in Chromium at
  // all, so a regression back to .code's flex would fail the precondition below.
  test("drag-selecting inside a snippet does not copy the whole snippet", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await devSignIn(page);
    await page.goto("/mcp");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));

    const box = page.getByRole("button", { name: "Copy the mcp.json configuration" });
    // Derive the drag from the rendered <code> rather than hard-coded pixels: the vertical middle
    // of the block lands on an inner JSON line, which is wide enough to select real characters.
    const geo = await box.evaluate((el) => {
      const r = el.querySelector("code")!.getBoundingClientRect();
      return { x: r.left + 12, y: r.top + r.height / 2 };
    });
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x + 200, geo.y, { steps: 10 });
    await page.mouse.up();

    // Precondition, asserted so a drag that selected nothing fails loudly instead of masquerading
    // as a working guard.
    expect(await page.evaluate(() => (window.getSelection()?.toString() ?? "").trim())).not.toBe("");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sentinel");
  });

  test("the account menu links to the MCP page", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/");
    await page.getByRole("button", { name: /account/i }).click();
    await expect(page.getByRole("menuitem", { name: "MCP server" })).toBeVisible();
  });

  test("the admin card reports status and can toggle the server off and back on", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    const card = page.locator("section", { has: page.getByRole("heading", { name: "MCP server" }) }).first();
    await card.getByRole("heading", { name: "MCP server" }).click();
    await expect(card.getByText(/Switch off|Switch on/)).toBeVisible();

    // Off is a KILL-SWITCH, not a purge: grants survive, and the /mcp page still lists them.
    const off = await page.request.patch("/api/admin/settings", { data: { mcpEnabled: false } });
    expect(off.ok(), await off.text()).toBeTruthy();
    const disabled = await (await page.request.get("/api/mcp/connections")).json();
    expect(disabled.enabled).toBe(false);
    // While off, registration is refused outright.
    const reg = await page.request.post("/oauth/register", { data: { redirect_uris: [REDIRECT] } });
    expect(reg.status()).toBe(503);

    const on = await page.request.patch("/api/admin/settings", { data: { mcpEnabled: true } });
    expect(on.ok(), await on.text()).toBeTruthy();
    const enabled = await (await page.request.get("/api/mcp/connections")).json();
    expect(enabled.enabled).toBe(true);
  });
});
