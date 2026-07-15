import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_WRAPPER_PLACEHOLDER,
  countWrapperPlaceholders,
  sanitizeWrapperHtml,
  validateWrapperHtml,
  textToHtmlFragment,
  flattenMarkdownLinks,
  renderWrappedEmailHtml,
  renderEmailText,
} from "./email-template.js";

test("sanitize: script/iframe/object/embed removed with content", () => {
  const dirty = `<p>hi</p><script>alert(1)</script><iframe src="x"></iframe><object data="x">o</object><embed src="x"><p>bye</p>`;
  const clean = sanitizeWrapperHtml(dirty);
  assert.equal(clean, "<p>hi</p><p>bye</p>");
});

test("sanitize: form tags stripped, children kept", () => {
  assert.equal(sanitizeWrapperHtml(`<form action="/x"><b>keep</b></form>`), "<b>keep</b>");
});

test("sanitize: on* handlers and javascript: URLs dropped, safe attrs kept", () => {
  const clean = sanitizeWrapperHtml(`<a href="javascript:alert(1)" onclick="x()" title="t">go</a><img src="https://x/y.png" onerror="p()">`);
  assert.equal(clean, `<a title="t">go</a><img src="https://x/y.png">`);
});

test("sanitize: obfuscated javascript: scheme (whitespace/control chars) still dropped", () => {
  const clean = sanitizeWrapperHtml(`<a href="java\nscript:alert(1)">x</a>`);
  assert.ok(!clean.includes("href"));
});

test("sanitize: vbscript: and non-image data: subtypes dropped (scheme allowlist, not denylist)", () => {
  const clean = sanitizeWrapperHtml(`<a href="vbscript:msgbox(1)">a</a><a href="data:text/html,<script>alert(1)</script>">b</a><a href="data:image/svg+xml,<svg onload=alert(1)>">c</a><a href="data:application/xhtml+xml,x">d</a>`);
  assert.ok(!/href/.test(clean), clean);
});

test("sanitize: safe data: image subtypes kept", () => {
  const clean = sanitizeWrapperHtml(`<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/jpeg;base64,x"><img src="data:image/gif;base64,x"><img src="data:image/webp;base64,x">`);
  assert.equal(
    clean,
    `<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/jpeg;base64,x"><img src="data:image/gif;base64,x"><img src="data:image/webp;base64,x">`,
  );
});

test("sanitize: mailto: links and scheme-less (relative/fragment) URLs are kept", () => {
  const clean = sanitizeWrapperHtml(`<a href="mailto:x@y.com">mail</a><a href="/relative">rel</a><a href="#frag">frag</a>`);
  assert.equal(clean, `<a href="mailto:x@y.com">mail</a><a href="/relative">rel</a><a href="#frag">frag</a>`);
});

test("sanitize: nested/split drop-tags cannot reassemble into live active content (fixpoint)", () => {
  // Removing the inner <iframe></iframe> pair would rejoin the halves into <script> — the
  // sanitizer must re-scan until stable and drop whatever reassembles.
  const out = sanitizeWrapperHtml(`<scr<iframe></iframe>ipt>alert(1)</scr<iframe></iframe>ipt>`);
  assert.ok(!/<script/i.test(out), out);
  // Orphan closers glue text the same way.
  const out2 = sanitizeWrapperHtml(`<scr</iframe>ipt>alert(2)</scr</iframe>ipt>`);
  assert.ok(!/<script/i.test(out2), out2);
  // Reassembly via the form (tag-only) strip.
  const out3 = sanitizeWrapperHtml(`<scr<form>ipt>alert(3)</scr</form>ipt>`);
  assert.ok(!/<script/i.test(out3), out3);
});

test("sanitize: conditional comments and style attributes survive (email idioms)", () => {
  const html = `<!--[if mso]>outlook<![endif]--><td style="color:#082773">x</td>`;
  assert.equal(sanitizeWrapperHtml(html), html);
});

test("sanitize resists ReDoS on adversarial unclosed-comment/tag input (js/polynomial-redos)", () => {
  const evilComments = "<!--".repeat(100_000);
  const evilTags = "<".repeat(100_000);
  const start = Date.now();
  sanitizeWrapperHtml(evilComments);
  sanitizeWrapperHtml(evilTags);
  sanitizeWrapperHtml(`<!--a>`.repeat(20_000));
  assert.ok(Date.now() - start < 1000, "sanitizeWrapperHtml must run in linear time on adversarial input");
});

test("sanitize: malformed unterminated tag with many hyphens does not cause polynomial backtracking in sanitizeTag's own regex", () => {
  // Shape CodeQL originally flagged for the tag-parsing regex: '<A' followed by many '-' with no
  // closing '>'. The ambiguity between the tag-name charclass and the (formerly unguarded) attrs
  // charclass was quadratic in isolation; this hardens sanitizeTag itself, in addition to the
  // outer tokenizer fix above, so it stays safe even if ever called with unconstrained input.
  const evil = `<A${"-".repeat(80000)}`;
  const start = Date.now();
  sanitizeWrapperHtml(evil);
  assert.ok(Date.now() - start < 1000, "sanitizeWrapperHtml should stay fast on pathological input");
});

test("placeholder contract: exactly one required", () => {
  assert.equal(validateWrapperHtml(`<div>no placeholder</div>`).ok, false);
  assert.equal(validateWrapperHtml(`<div>${EMAIL_WRAPPER_PLACEHOLDER} and ${EMAIL_WRAPPER_PLACEHOLDER}</div>`).ok, false);
  const v = validateWrapperHtml(`<div>${EMAIL_WRAPPER_PLACEHOLDER}</div>`);
  assert.equal(v.ok, true);
  assert.equal(countWrapperPlaceholders((v as { sanitized: string }).sanitized), 1);
});

test("placeholder is case-sensitive", () => {
  assert.equal(validateWrapperHtml(`<div>[system message]</div>`).ok, false);
});

test("placeholder validation runs AFTER sanitization (placeholder inside script doesn't count)", () => {
  assert.equal(validateWrapperHtml(`<script>${EMAIL_WRAPPER_PLACEHOLDER}</script>`).ok, false);
});

test("textToHtmlFragment: escapes, linkifies, and preserves line breaks", () => {
  const frag = textToHtmlFragment(`<b>&\nView it: https://skilly.example.com/skills/global/pdf`);
  assert.ok(frag.startsWith("&lt;b&gt;&amp;<br>"));
  assert.ok(frag.includes(`<a href="https://skilly.example.com/skills/global/pdf">https://skilly.example.com/skills/global/pdf</a>`));
});

test("textToHtmlFragment: [label](url) becomes an anchor and the markdown syntax does not leak", () => {
  const frag = textToHtmlFragment("You have a new message. [See the message](https://s.example.com/?conversation=c1)");
  assert.ok(frag.includes(`<a href="https://s.example.com/?conversation=c1">See the message</a>`), frag);
  assert.ok(!frag.includes("[See the message]"), frag);
});

test("textToHtmlFragment: & in a markdown-link URL is escaped in the href", () => {
  const frag = textToHtmlFragment("[go](https://s.example.com/a?b=1&c=2)");
  assert.ok(frag.includes(`<a href="https://s.example.com/a?b=1&amp;c=2">go</a>`), frag);
});

test("textToHtmlFragment: a markdown-link label's own HTML is escaped", () => {
  const frag = textToHtmlFragment("[<b>x</b>](https://s.example.com/y)");
  assert.ok(frag.includes(`<a href="https://s.example.com/y">&lt;b&gt;x&lt;/b&gt;</a>`), frag);
});

test("flattenMarkdownLinks: [label](url) becomes 'label: url' for the plain-text part", () => {
  assert.equal(flattenMarkdownLinks("Hi. [See it](https://s.example.com/x)"), "Hi. See it: https://s.example.com/x");
});

test("renderWrappedEmailHtml: substitutes once and always appends the manage footer", () => {
  const html = renderWrappedEmailHtml(`<div>${EMAIL_WRAPPER_PLACEHOLDER}</div>`, "hello $& world", "https://s.example.com/");
  assert.ok(html.includes("hello $&amp; world")); // `$&` in the message must not trigger replace() patterns
  assert.ok(html.includes(`href="https://s.example.com/profile"`));
  assert.ok(html.includes("Manage email notifications"));
});

test("renderEmailText: flattens markdown links and appends the manage line (absolute when base URL known)", () => {
  const out = renderEmailText("Hi. [See it](https://s.example.com/x)", "https://s.example.com");
  assert.ok(out.includes("See it: https://s.example.com/x"), out);
  assert.ok(!out.includes("[See it]"), out);
  assert.ok(out.includes("https://s.example.com/profile"));
  assert.ok(renderEmailText("msg", "").includes("Manage email notifications"));
});
