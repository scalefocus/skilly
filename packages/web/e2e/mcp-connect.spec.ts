// e2e: the §29 MCP connect flow — Dynamic Client Registration → authorize → consent → a
// single-use authorization code, plus the /mcp-server page and the admin card.
//
// DOCUMENTED BOUNDARY: the token endpoint and the MCP endpoint itself live on the WORKER (§29
// "Shape & placement"), and this suite runs against the web dev server only. So this spec covers
// everything web owns — registration, the consent screen's contents and both of its outcomes, the
// Connections list, and revocation — and stops at the hand-off carrying the code. The worker half
// (code exchange, PKCE verification, refresh rotation, reuse detection, every tool and resource
// read) is covered by the worker's own integration suites (packages/worker/src/mcp/*.test.ts).
import { test, expect, devSignIn } from "./fixtures";
import { reloadReady } from "./helpers/ready";

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

// The click-to-copy toast specifically. `role="status"` is NOT unique on an authed page — the shell
// also renders the §31.4 badge-earned toast, the §23 update notice and the header search's
// empty-state bubble as live regions, so a bare getByRole("status") is a strict-mode violation the
// moment the dev user has an unearned badge waiting.
const copyToast = (page: import("@playwright/test").Page) => page.locator(".toast");

// The Claude Code command for a scope (§29): `user` = Every project (the default), `local` = This project.
const claudeCodeCmd = (scope: "user" | "local") =>
  new RegExp(`^claude mcp add --transport http --scope ${scope} skilly https?:\\/\\/\\S+\\/mcp$`);

// The text of a connect snippet (§29). The box named `name` is the click target, but its text also
// holds the positioned `copy` pill, so a text assertion on the box reads "…/mcpcopy". Assert on the
// <code> inside it; click the box itself.
const snippet = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name }).locator(".code-cmd");

// The consent form's submit (§29): the POST the Approve / Decline buttons make.
const isConsentSubmit = (r: import("@playwright/test").Response) =>
  r.request().method() === "POST" && new URL(r.url()).pathname === "/oauth/consent";

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

    // A single, genuinely unregistered redirect_uri: the mismatch is what's reported.
    const client = await registerClient(page, "Redirect Mismatch Client");
    const mismatch = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://evil.example.com/cb",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      state: "e2e-state",
    });
    await page.goto(`/oauth/authorize?${mismatch.toString()}`);
    await expect(page.getByText(/does not match this client/)).toBeVisible();
    // Parsed host, not a substring: the unregistered URI is legitimately present in the query we
    // sent, so only the document's own host tells us whether we were redirected to it.
    expect(new URL(page.url()).host).not.toBe("evil.example.com");
    expect(new URL(page.url()).pathname).toBe("/oauth/authorize");
  });

  // OAuth 2.1: a repeated parameter is rejected outright. Smuggling a second redirect_uri past a
  // registered one must NOT resolve to the registered value and sail through as verified. §29.
  test("a redirect_uri supplied twice is rejected rather than resolved to the registered one", async ({ page }) => {
    await devSignIn(page);
    const client = await registerClient(page, "Duplicate Param Client");
    await page.goto(`${authorizeUrl(client.client_id)}&redirect_uri=${encodeURIComponent("https://evil.example.com/cb")}`);
    await expect(page.getByText(/redirect_uri parameter was supplied more than once/)).toBeVisible();
    // Still on the registry's own authorize URL. Assert on the parsed host/path, not the raw string:
    // "evil.example.com" legitimately appears in the query we sent, so a substring check would fail
    // on a correct result. What matters is that we never NAVIGATED there.
    const landed = new URL(page.url());
    expect(landed.host).not.toBe("evil.example.com");
    expect(landed.pathname).toBe("/oauth/authorize");
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });

  test("a missing PKCE challenge renders the error page — it is never redirected to the client (§49.5)", async ({ page }) => {
    await devSignIn(page);
    const client = await registerClient(page, "No PKCE Client");
    const p = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "s",
    });
    // The redirect_uri IS verified here, and the endpoint still does not redirect: an authorize
    // endpoint that bounces a malformed request before consent is an open redirector for any
    // self-registered client. The OAuth error code lands on the page instead (§49.5).
    const res = await page.request.get(`/oauth/authorize?${p.toString()}`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers().location).toBeUndefined();
    const html = await res.text();
    expect(html).toContain("PKCE is required");
    expect(html).toContain("invalid_request");
    expect(html).not.toContain("Approve");
  });

  test("approving mints a code and lists the connection; revoking removes it", async ({ page }) => {
    await devSignIn(page);
    // Unique per run: a grant survives a failed attempt, so a retry (CI runs with retries:1) would
    // otherwise find TWO connections under the same name and trip strict mode on the listing below.
    const name = `Approve Then Revoke ${Date.now()}`;
    const client = await registerClient(page, name);
    await page.goto(authorizeUrl(client.client_id));

    // The loopback redirect won't resolve — that's fine, we only need the URL the browser was sent to.
    const [nav, consent] = await Promise.all([
      page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 15_000 }).catch(() => null),
      page.waitForResponse(isConsentSubmit, { timeout: 15_000 }),
      page.getByRole("button", { name: "Approve" }).click(),
    ]);
    // §29: the submit answers with skilly's own hand-off page — a 200, never a redirect. (Status and
    // headers only: the body is gone the moment the page navigates on. It is read in the test below.)
    expect(consent.status()).toBe(200);
    expect(consent.headers().location).toBeUndefined();
    expect(consent.headers()["content-type"]).toContain("text/html");
    const landed = nav?.url() ?? page.url();
    expect(landed).toContain("code=");
    expect(landed).toContain("state=e2e-state");
    // RFC 9207: the issuer is echoed so the client can bind the response.
    expect(landed).toContain("iss=");

    // The grant now shows on the MCP page, and can be revoked from there.
    const list = await (await page.request.get("/api/mcp/connections")).json();
    const conn = (list.connections as Array<{ grantId: string; clientName: string }>).find(
      (c) => c.clientName === name,
    );
    expect(conn, JSON.stringify(list)).toBeTruthy();

    // The hand-off page sends the browser to the loopback callback, which refuses the connection.
    // Let that navigation finish failing before we navigate away, or this goto races it and is
    // interrupted ("interrupted by another navigation to chrome-error://chromewebdata/"). The page
    // passes through /oauth/consent on the way, so wait until it has left /oauth/ altogether.
    await page.waitForURL((u) => !u.toString().includes("/oauth/"), { timeout: 15_000 }).catch(() => {});

    await page.goto("/mcp-server");
    await expect(page.getByRole("heading", { name: "MCP server" })).toBeVisible();
    await expect(page.getByText(name)).toBeVisible();
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
    const name = `Declining ${Date.now()}`;
    const client = await registerClient(page, name);
    await page.goto(authorizeUrl(client.client_id));

    const [nav] = await Promise.all([
      page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 15_000 }).catch(() => null),
      page.getByRole("button", { name: "Decline" }).click(),
    ]);
    expect(nav?.url() ?? page.url()).toContain("error=access_denied");

    const list = await (await page.request.get("/api/mcp/connections")).json();
    expect(
      (list.connections as Array<{ clientName: string }>).some((c) => c.clientName === name),
    ).toBeFalsy();
  });

  // §29: every answer of the consent submit is a page. Submitted through the API context (same
  // session cookie) so the bodies can be read — in the browser the hand-off page is replaced by the
  // next navigation as soon as it arrives.
  test("the consent submit answers with a hand-off page, and a replayed request with the 400 page", async ({ page }) => {
    await devSignIn(page);
    const name = `Hand-off ${Date.now()}`;
    const client = await registerClient(page, name);
    await page.goto(authorizeUrl(client.client_id));
    const requestId = await page.locator('input[name="requestId"]').getAttribute("value");
    expect(requestId).toBeTruthy();

    // maxRedirects: 0 — a redirect answer must be seen as one, not followed to a dead loopback port.
    const first = await page.request.post("/oauth/consent", {
      form: { requestId: requestId!, decision: "deny" },
      maxRedirects: 0,
    });
    expect(first.status(), await first.text()).toBe(200);
    expect(first.headers().location).toBeUndefined();
    expect(first.headers()["content-type"]).toContain("text/html");
    expect(first.headers()["cache-control"]).toContain("no-store");
    const handoff = await first.text();
    // The automatic step and the Continue link go to the same place: the registered redirect URI.
    const target = `${REDIRECT}?error=access_denied`;
    expect(handoff).toContain(`<meta http-equiv="refresh" content="0;url=${target}`);
    expect(handoff).toContain(`href="${target}`);
    expect(handoff).toContain("state=e2e-state");
    expect(handoff).toContain("You declined");
    expect(handoff).toContain(name);
    expect(handoff).not.toMatch(/<script/i);

    // Single-use: the same id again is refused — as a page a person can read, not JSON on a blank
    // tab — and it sends nobody anywhere.
    const replay = await page.request.post("/oauth/consent", {
      form: { requestId: requestId!, decision: "approve" },
      maxRedirects: 0,
    });
    expect(replay.status()).toBe(400);
    expect(replay.headers()["content-type"]).toContain("text/html");
    const refused = await replay.text();
    expect(refused).toContain("expired or was already answered");
    expect(refused).not.toContain('http-equiv="refresh"');
    expect(refused).not.toContain(REDIRECT);

    // The replayed Approve authorized nothing.
    const list = await (await page.request.get("/api/mcp/connections")).json();
    expect(
      (list.connections as Array<{ clientName: string }>).some((c) => c.clientName === name),
    ).toBeFalsy();
  });

  // The regression case for the incident behind v2.66.1 (§22, §29). A deployment's edge proxy
  // replaced skilly's CSP with its own, whose `form-action` did not name the client's origin.
  // Browsers enforce `form-action` across redirects, so the consent form's 303 to the client was
  // dropped: Approve did nothing, and the retry met an already-consumed request. The submit now
  // answers with a same-origin page that navigates on, which `form-action` does not govern.
  test("Approve still reaches the client when an edge proxy replaces the CSP with a strict one", async ({ page }) => {
    await devSignIn(page);
    const name = `Edge CSP ${Date.now()}`;
    const client = await registerClient(page, name);

    // What a hardening edge does: discard the app's policy and send its own. Scripts stay allowed
    // so the dev app shell behaves as usual; `form-action 'self'` is the part under test.
    const EDGE_CSP =
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'";
    await page.route(
      (url) => url.pathname === "/oauth/authorize" || url.pathname === "/oauth/consent",
      async (route) => {
        // maxRedirects: 0 — a redirect answer has to reach the BROWSER, where form-action is enforced.
        const response = await route.fetch({ maxRedirects: 0 });
        const headers: Record<string, string> = { ...response.headers(), "content-security-policy": EDGE_CSP };
        delete headers["content-security-policy-report-only"];
        await route.fulfill({ response, headers });
      },
    );

    const consentScreen = await page.goto(authorizeUrl(client.client_id));
    // The edge policy is what the document was served with — otherwise this test proves nothing.
    expect(consentScreen?.headers()["content-security-policy"]).toBe(EDGE_CSP);

    // No `.catch` here: under the old redirect this request is never made, and the test must fail.
    const [nav, consent] = await Promise.all([
      page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 15_000 }),
      page.waitForResponse(isConsentSubmit, { timeout: 15_000 }),
      page.getByRole("button", { name: "Approve" }).click(),
    ]);
    expect(consent.headers()["content-security-policy"]).toBe(EDGE_CSP);
    expect(nav.url()).toContain("code=");
    expect(nav.url()).toContain("state=e2e-state");

    // Tidy up the grant this approval created.
    const list = await (await page.request.get("/api/mcp/connections")).json();
    const conn = (list.connections as Array<{ grantId: string; clientName: string }>).find(
      (c) => c.clientName === name,
    );
    expect(conn, JSON.stringify(list)).toBeTruthy();
    const del = await page.request.delete(`/api/mcp/connections/${conn!.grantId}`);
    expect(del.ok(), await del.text()).toBeTruthy();
  });

  test("the MCP page shows the server URL and the connect snippets", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/mcp-server");
    // The copy affordance is the box itself, named per field (§29) — not a "Copy" button beside it.
    // Neither box renders until the server URL has loaded, and a cold `next dev` route compile can
    // outlast the default expect timeout, so the first wait is explicit.
    const code = snippet(page, "Copy the Claude Code command");
    await expect(code).toBeVisible({ timeout: 30_000 });
    // Asserted WITH the URL: a bare `getByText("claude mcp add …")` also matches the truncated
    // command the page used to render mid-fetch, so it proved nothing about the URL being there.
    // A fresh context has nothing stored, so the toggle starts on Every project (`--scope user`).
    await expect(code).toHaveText(claudeCodeCmd("user"));
    await expect(page.getByRole("button", { name: "Every project" })).toHaveAttribute("aria-pressed", "true");

    // VS Code reads `servers`, never `mcpServers` (the page once shipped the wrong key).
    const vscode = snippet(page, "Copy the VS Code configuration");
    await expect(vscode).toContainText('"servers"');
    await expect(vscode).not.toContainText("mcpServers");
    await expect(vscode).toContainText(/"url": "https?:\/\/\S+"/);

    const cursor = snippet(page, "Copy the Cursor configuration");
    await expect(cursor).toContainText('"mcpServers"');
    await expect(cursor).toContainText(/"url": "https?:\/\/\S+"/);

    // Claude Desktop / claude.ai: connector steps plus the bare URL to paste — no JSON.
    await expect(page.getByText("Add custom connector")).toBeVisible();
    await expect(snippet(page, "Copy the server URL")).toHaveText(/^https?:\/\/\S+\/mcp$/);
  });

  // §29: one toggle drives Claude Code, VS Code and Cursor, and is remembered in this browser.
  test("the scope toggle switches the snippets and survives a reload", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/mcp-server");
    const code = snippet(page, "Copy the Claude Code command");
    // The command renders only after the client fetch, so the page is hydrated once it is visible.
    await expect(code).toHaveText(claudeCodeCmd("user"), { timeout: 30_000 });
    await expect(page.getByText("Run MCP: Open User Configuration from the Command Palette")).toBeVisible();
    await expect(page.getByText("Save as ~/.cursor/mcp.json")).toBeVisible();

    await page.getByRole("button", { name: "This project" }).click();
    await expect(code).toHaveText(claudeCodeCmd("local"));
    await expect(page.getByRole("button", { name: "This project" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Run it inside the project folder.")).toBeVisible();
    await expect(page.getByText("Save as .vscode/mcp.json in the workspace")).toBeVisible();
    await expect(page.getByText("Save as .cursor/mcp.json in the project")).toBeVisible();

    await reloadReady(page);
    await expect(code).toHaveText(claudeCodeCmd("local"), { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "This project" })).toHaveAttribute("aria-pressed", "true");

    // Back to the default, so the stored choice is the one a fresh visit would make anyway.
    await page.getByRole("button", { name: "Every project" }).click();
    await expect(code).toHaveText(claudeCodeCmd("user"));
  });

  // §29: clicking anywhere in a connect snippet copies the whole thing, the same UX as §23's
  // install-command row. Clipboard permissions are Chromium-only — the suite's only project.
  test("clicking a connect snippet copies it to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await devSignIn(page);
    await page.goto("/mcp-server");

    await page.getByRole("button", { name: "Copy the Claude Code command" }).click();
    await expect(copyToast(page)).toHaveText("✓ Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(claudeCodeCmd("user"));

    await page.getByRole("button", { name: "Copy the VS Code configuration" }).click();
    const vscode = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(vscode).toMatchObject({ servers: { skilly: { type: "http" } } });
    expect(vscode.servers.skilly.url).toMatch(/^https?:\/\/\S+\/mcp$/);

    await page.getByRole("button", { name: "Copy the Cursor configuration" }).click();
    const cursor = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(Object.keys(cursor.mcpServers.skilly)).toEqual(["url"]);
    expect(cursor.mcpServers.skilly.url).toMatch(/^https?:\/\/\S+\/mcp$/);
  });

  // §29: the pill is a sibling of the scrolling box, not a child, so "click the field" and "click
  // the button" only behave identically because the interactive attributes sit on the wrapper.
  // Clicking the pill directly is the case that regresses silently if that ever moves.
  test("clicking the copy pill itself copies, not just the field", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await devSignIn(page);
    await page.goto("/mcp-server");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));

    const box = page.getByRole("button", { name: "Copy the Claude Code command" });
    await box.waitFor({ timeout: 30_000 });
    // Click the pill's own centre — not the box's.
    const pill = await box.evaluate((el) => {
      const r = el.querySelector("span.btn")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(pill.x, pill.y);
    await expect(copyToast(page)).toHaveText("✓ Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(claudeCodeCmd("user"));
  });

  // §29: a drag-select inside a snippet must NOT be hijacked into a full copy — the click event
  // that follows mouseup sees a live selection and is ignored, so a user grabbing just the URL out
  // of a JSON block keeps both their selection and their clipboard. This also guards the
  // `display:block` override: text inside a flex container is not drag-selectable in Chromium at
  // all, so a regression back to .code's flex would fail the precondition below.
  test("drag-selecting inside a snippet does not copy the whole snippet", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await devSignIn(page);
    await page.goto("/mcp-server");
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));

    const box = page.getByRole("button", { name: "Copy the VS Code configuration" });
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
    const item = page.getByRole("menuitem", { name: "MCP server" });
    await expect(item).toBeVisible();
    // Never /mcp: that is the worker's endpoint, and behind the proxy the page there is unreachable
    // (§13). proxyRouting.test.ts guards the proxy side; this guards the link.
    await expect(item).toHaveAttribute("href", "/mcp-server");
  });

  test("the admin card reports status and can toggle the server off and back on", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    const card = page.locator("section", { has: page.getByRole("heading", { name: "MCP server" }) }).first();
    await card.getByRole("heading", { name: "MCP server" }).click();
    await expect(card.getByText(/Switch off|Switch on/)).toBeVisible();

    // Off is a KILL-SWITCH, not a purge: grants survive, and the /mcp-server page still lists them.
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
