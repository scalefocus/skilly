// Unit tests for the consent submit's two documents (SKILLY_SPEC.md §29): the hand-off page and
// the consent error page. Pure — no Next runtime, no DB.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSENT_FAILURES,
  buildConsentErrorPage,
  buildHandoffPage,
  consentPageResponse,
  describeTarget,
  escapeHtml,
  isSafeHandoffTarget,
} from "./consentPages";

/** Undo escapeHtml, to compare what the BROWSER will read out of an attribute with what we put in. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
const refreshUrl = (html: string) => /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(html)?.[1];
const linkUrl = (html: string) => /<a class="btn" href="([^"]*)"/.exec(html)?.[1];

const APPROVED = "https://ai.example.com/oauth/clients/mcp:skilly/callback?code=abc123&state=s%3B1&iss=https%3A%2F%2Fskilly.example.com";

test("hand-off page: the refresh and the Continue link carry the identical, intact target", () => {
  const html = buildHandoffPage({ clientName: "Open WebUI", target: APPROVED, outcome: "approve" });
  const refresh = refreshUrl(html);
  const link = linkUrl(html);
  assert.ok(refresh, "expected a zero-delay meta refresh");
  assert.equal(refresh, link, "the automatic step and the link must go to the same place");
  // What the browser decodes out of the attribute is byte-for-byte the server-built URL.
  assert.equal(unescapeHtml(refresh!), APPROVED);
  // …and the raw `&` separators never reach the markup unescaped.
  assert.ok(html.includes("code=abc123&amp;state="));
});

test("hand-off page: names the client and where it is sending the person", () => {
  const approve = buildHandoffPage({ clientName: "Open WebUI", target: APPROVED, outcome: "approve" });
  assert.match(approve, /<h1>Returning you to <strong>Open WebUI<\/strong><\/h1>/);
  assert.match(approve, /<p class="where">ai\.example\.com<\/p>/);

  const deny = buildHandoffPage({
    clientName: "Open WebUI",
    target: "https://ai.example.com/cb?error=access_denied&state=s",
    outcome: "deny",
  });
  assert.match(deny, /<h1>You declined — nothing was authorized<\/h1>/);
  assert.match(deny, /Returning you to <strong>Open WebUI<\/strong>\./);
  assert.ok(!deny.includes("You approved"), "a decline must not read as an approval");
});

test("hand-off page: a hostile client name or target cannot break out of the markup", () => {
  const name = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const target = `https://evil.example.com/cb?x="><script>alert(3)</script>&code=c`;
  const html = buildHandoffPage({ clientName: name, target, outcome: "approve" });
  assert.ok(!/<script/i.test(html), "no script element, injected or otherwise");
  assert.ok(!/<img/i.test(html), "no injected element");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // The attribute still decodes to exactly the target, so escaping changed nothing about where it goes.
  assert.equal(unescapeHtml(refreshUrl(html)!), target);
  assert.equal(unescapeHtml(linkUrl(html)!), target);
});

test("both documents are self-contained: no scripts, no external resources, never referring", () => {
  const pages = [
    buildHandoffPage({ clientName: "Open WebUI", target: APPROVED, outcome: "approve" }),
    buildHandoffPage({ clientName: "CLI", target: "http://127.0.0.1:53124/callback?error=access_denied", outcome: "deny" }),
    buildConsentErrorPage(CONSENT_FAILURES.expired.message),
  ];
  for (const html of pages) {
    assert.ok(!/<script/i.test(html), "no script");
    assert.ok(!/<link\b/i.test(html), "no stylesheet / preload link");
    assert.ok(!/<img\b|<iframe\b|<object\b|<embed\b/i.test(html), "no embedded resource");
    assert.ok(!/@import|url\(/i.test(html), "no CSS fetch");
    assert.ok(!/\son[a-z]+\s*=/i.test(html), "no inline event handler");
    assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
    // A proper document all the same.
    assert.ok(html.startsWith("<!doctype html>\n<html lang=\"en\">"));
    assert.equal((html.match(/<h1>/g) ?? []).length, 1, "exactly one h1");
    assert.match(html, /<title>[^<]+<\/title>/);
  }
});

test("describeTarget: host for http(s), with the port for a loopback client; scheme for an app scheme", () => {
  assert.equal(describeTarget("https://ai.example.com/oauth/callback?code=x"), "ai.example.com");
  assert.equal(describeTarget("http://127.0.0.1:53124/callback?code=x"), "127.0.0.1:53124");
  assert.equal(describeTarget("cursor://anysphere.cursor-mcp/oauth/callback?code=x"), "cursor:");
  assert.equal(describeTarget("not a url"), "");
});

test("isSafeHandoffTarget: refuses every scheme registration refuses (§49.5), and anything unparseable", () => {
  for (const ok of [APPROVED, "http://127.0.0.1:8976/callback?code=x", "cursor://host/cb?code=x"]) {
    assert.equal(isSafeHandoffTarget(ok), true, ok);
  }
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://x/y",
    "about:blank",
    "",
    "/relative/path",
  ]) {
    assert.equal(isSafeHandoffTarget(bad), false, bad);
  }
  // The builder enforces it too: a link is clickable where a 303 Location never was.
  assert.throws(() => buildHandoffPage({ clientName: "x", target: "javascript:alert(1)", outcome: "approve" }));
});

test("consent error page: shows the reason, links back into skilly, and never points at a client", () => {
  for (const [name, f] of Object.entries(CONSENT_FAILURES)) {
    const html = buildConsentErrorPage(f.message);
    assert.match(html, /<h1>This connection request can&rsquo;t be completed<\/h1>/, name);
    assert.ok(html.includes(escapeHtml(f.message)), name);
    assert.ok(html.includes('<a href="/mcp-server">'), name);
    assert.ok(!/http-equiv="refresh"/i.test(html), `${name}: an error page must not navigate anywhere`);
    assert.ok(!/href="https?:/i.test(html), `${name}: no off-site link`);
  }
});

test("CONSENT_FAILURES: the status codes of §29's table", () => {
  const status = Object.fromEntries(Object.entries(CONSENT_FAILURES).map(([k, v]) => [k, v.status]));
  assert.deepEqual(status, {
    mcpDisabled: 503,
    signedOut: 401,
    notProvisioned: 403,
    rateLimited: 429,
    incomplete: 400,
    expired: 400,
    unknownClient: 400,
    blockedClient: 403,
  });
});

test("consentPageResponse: HTML, never cacheable, extra headers kept", async () => {
  const res = consentPageResponse("<!doctype html>", 429, { "retry-after": "17" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("retry-after"), "17");
  assert.equal(res.headers.get("location"), null);
  assert.equal(await res.text(), "<!doctype html>");
});
