// The §12 email HTML wrapper: sanitization, the [SYSTEM MESSAGE] placeholder contract, and
// the pure renderers that turn a notification's plain text into the wrapped HTML + text parts.
// Client-safe (no node imports) — the admin WYSIWYG editor shares the placeholder constant and
// validation so the save error is predictable before the server re-validates authoritatively.
// SKILLY_SPEC.md §12 (HTML message wrapper).

/** The literal, case-sensitive token the wrapper must contain exactly once. */
export const EMAIL_WRAPPER_PLACEHOLDER = "[SYSTEM MESSAGE]";

/** Count occurrences of the literal placeholder (case-sensitive). */
export function countWrapperPlaceholders(html: string): number {
  return html.split(EMAIL_WRAPPER_PLACEHOLDER).length - 1;
}

// Tags removed together with their content — active content that must never survive a save.
const DROP_WITH_CONTENT = ["script", "iframe", "object", "embed"];
// Tags whose open/close markers are stripped but whose children are kept (§12 strips `form`).
const DROP_TAG_ONLY = ["form"];
// URL-bearing attributes checked for javascript:/data: payloads.
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "background"]);

function safeUrlValue(raw: string): boolean {
  // Strip quotes, whitespace and control characters before checking the scheme — defeats
  // "java\nscript:" style obfuscation.
  const unquoted = raw.replace(/^["']|["']$/g, "");
  let v = "";
  for (const ch of unquoted) {
    const c = ch.charCodeAt(0);
    if (c > 32 && c !== 127) v += ch; // drop whitespace + ASCII control chars
  }
  v = v.toLowerCase();
  return !v.startsWith("javascript:") && !v.startsWith("vbscript:") && !v.startsWith("data:text/html");
}

/** Rebuild one tag keeping only safe attributes (drops on* handlers and js: URLs). */
function sanitizeTag(tag: string): string {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)>$/.exec(tag);
  if (!m) return ""; // malformed pseudo-tag — drop it rather than guess
  const [, close, name, rawAttrs, selfClose] = m;
  // Belt-and-suspenders: a drop-tag that reaches this pass (e.g. reassembled by an earlier
  // removal) is dropped here too — the fixpoint loop in sanitizeWrapperHtml then re-checks.
  const lower = name!.toLowerCase();
  if (DROP_WITH_CONTENT.includes(lower) || DROP_TAG_ONLY.includes(lower)) return "";
  if (close) return `</${name!.toLowerCase()}>`;
  let attrs = "";
  // Each match starts with a mandatory name character, so the regex always advances —
  // no zero-width-loop guard needed.
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
  for (let a = attrRe.exec(rawAttrs ?? ""); a; a = attrRe.exec(rawAttrs ?? "")) {
    const attrName = a[1]!.toLowerCase();
    if (attrName.startsWith("on")) continue; // event handlers
    const value = a[3] ?? "";
    if (URL_ATTRS.has(attrName) && !safeUrlValue(value)) continue;
    attrs += a[2] ? ` ${attrName}=${value}` : ` ${attrName}`;
  }
  return `<${name!.toLowerCase()}${attrs}${selfClose ? " /" : ""}>`;
}

function sanitizePass(html: string): string {
  let out = html;
  for (const t of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}\\s*>`, "gi"), "");
    out = out.replace(new RegExp(`</?${t}\\b[^>]*>`, "gi"), ""); // unclosed opens + orphan closers
  }
  for (const t of DROP_TAG_ONLY) {
    out = out.replace(new RegExp(`</?${t}\\b[^>]*>`, "gi"), "");
  }
  // Rewrite every remaining tag through the attribute filter (comments pass through —
  // conditional comments are load-bearing in HTML email).
  return out.replace(/<!--[\s\S]*?-->|<[^>]+>/g, (tok) => (tok.startsWith("<!--") ? tok : sanitizeTag(tok)));
}

/**
 * Allowlist-flavoured sanitizer for the ADMIN-authored wrapper (§12): removes
 * script/iframe/object/embed with their content, strips form tags, drops every `on*`
 * attribute and javascript:-style URL. Defense-in-depth for the in-app editor/preview —
 * the author is a platform admin, but stored HTML should still never carry active content.
 *
 * Removing or rewriting a token can reassemble the surrounding characters into a NEW tag
 * (`<scr<iframe></iframe>ipt>` → `<script>`), so a single pass is bypassable — iterate to a
 * fixpoint and refuse pathological input that won't converge (empty output then fails the
 * placeholder validation, so the save is rejected).
 */
export function sanitizeWrapperHtml(html: string): string {
  let out = html;
  for (let i = 0; i < 25; i++) {
    const next = sanitizePass(out);
    if (next === out) return out;
    out = next;
  }
  return "";
}

export type WrapperValidation = { ok: true; sanitized: string } | { ok: false; error: string };

/** Sanitize + enforce the placeholder contract: exactly one literal [SYSTEM MESSAGE]. */
export function validateWrapperHtml(html: string): WrapperValidation {
  if (typeof html !== "string" || html.trim() === "") return { ok: false, error: "the wrapper cannot be empty" };
  const sanitized = sanitizeWrapperHtml(html);
  const n = countWrapperPlaceholders(sanitized);
  if (n === 0) return { ok: false, error: `the wrapper must contain the placeholder ${EMAIL_WRAPPER_PLACEHOLDER}` };
  if (n > 1) return { ok: false, error: `the placeholder ${EMAIL_WRAPPER_PLACEHOLDER} may appear only once (found ${n})` };
  return { ok: true, sanitized };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Match a markdown-style link `[label](https://…)` — the only markup the notification renderer
 * emits (§12 Notification content). The URL must be absolute http(s); the label is any run
 * without a closing `]`.
 */
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Turn a notification's rendered text into an HTML fragment: `[label](url)` call-to-actions
 * become clickable anchors, bare URLs stay auto-linked, everything else is HTML-escaped and
 * newlines become <br>. The email therefore carries the same link as the in-app notification (§12).
 */
export function textToHtmlFragment(text: string): string {
  // Walk the text link-by-link: the segments AROUND each markdown link are escaped and have their
  // bare URLs auto-linked; each `[label](url)` becomes an anchor built from separately-escaped
  // parts. This keeps the URL inside a markdown link from being double-processed by the bare-URL
  // linkifier, without needing placeholder tokens.
  const autolink = (s: string) => s.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const at = m.index ?? 0;
    out += autolink(escapeHtml(text.slice(last, at)));
    const label = m[1]!;
    const url = m[2]!;
    out += safeUrlValue(url)
      ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
      : escapeHtml(label); // unreachable for http(s), but degrade to plain text defensively
    last = at + m[0].length;
  }
  out += autolink(escapeHtml(text.slice(last)));
  return out.replace(/\n/g, "<br>\n");
}

/** Flatten `[label](url)` to `label: url` for the plain-text part (keeps the URL clickable). */
export function flattenMarkdownLinks(text: string): string {
  return text.replace(MARKDOWN_LINK, (_m, label: string, url: string) => `${label}: ${url}`);
}

/** The always-appended opt-out pointer (§12). Absolute when the base URL is known. */
export function manageEmailFooterHtml(baseUrl: string): string {
  const inner = baseUrl
    ? `<a href="${escapeHtml(baseUrl.replace(/\/$/, ""))}/profile">Manage email notifications</a>`
    : "Manage email notifications in your skilly profile.";
  return `<p style="margin-top:24px;font-size:12px;color:#888888">${inner}</p>`;
}

export function manageEmailFooterText(baseUrl: string): string {
  return baseUrl
    ? `\n\n—\nManage email notifications: ${baseUrl.replace(/\/$/, "")}/profile`
    : "\n\n—\nManage email notifications in your skilly profile.";
}

/**
 * Render the HTML part of a notification email: the plain-text message becomes an HTML
 * fragment substituted for [SYSTEM MESSAGE] in the (already-sanitized, validated) wrapper,
 * and the manage-preferences footer is appended even when the template omits it.
 */
export function renderWrappedEmailHtml(wrapperHtml: string, messageText: string, baseUrl: string): string {
  const fragment = textToHtmlFragment(messageText);
  return wrapperHtml.replace(EMAIL_WRAPPER_PLACEHOLDER, () => fragment) + manageEmailFooterHtml(baseUrl);
}

/** Render the plain-text alternative part: the message (markdown links flattened) + the manage line. */
export function renderEmailText(messageText: string, baseUrl: string): string {
  return flattenMarkdownLinks(messageText) + manageEmailFooterText(baseUrl);
}
