// The two documents `POST /oauth/consent` answers with (SKILLY_SPEC.md §29): the hand-off page that
// sends the browser on to the MCP client, and the error page for every failure of the submit.
//
// WHY A PAGE AND NOT A REDIRECT. Browsers enforce CSP `form-action` across redirects, so a 303 from
// the consent form to the client's redirect_uri is only delivered when the consent screen's policy
// names that origin. That held under skilly's own header and broke the moment an edge proxy replaced
// it: the redirect was dropped after the consent request had been consumed, the client never got its
// code, and a second Approve met "already used". A 200 document followed by an ordinary navigation
// is outside `form-action` altogether, so it works under `form-action 'self'` and under an edge's
// policy alike (§22).
//
// Both documents are SELF-CONTAINED: no scripts, no external resources, inline styles only, and
// they still work with the styles blocked. That is what keeps them independent of whatever policy
// the response ends up carrying. Pure — no DB, no `next/*` — so it runs under `node --test`.
import { REFUSED_REDIRECT_SCHEMES } from "@skilly/shared";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * May the browser be handed this URL? Registration already refuses script-capable and local schemes
 * (§49.5) and the redirect_uri is matched against the registration, so this never fails for a real
 * client. It is here because the page carries the target in an `<a href>`, where a `javascript:`
 * URL would be clickable — a 303 `Location` never was.
 */
export function isSafeHandoffTarget(target: string): boolean {
  try {
    return !REFUSED_REDIRECT_SCHEMES.has(new URL(target).protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Where the hand-off goes, as shown to the person: the host for an http(s) target (with its port —
 * `127.0.0.1:53124` for a loopback client), the scheme for an app-scheme client (`cursor:`).
 */
export function describeTarget(target: string): string {
  try {
    const u = new URL(target);
    return u.protocol === "https:" || u.protocol === "http:" ? u.host : u.protocol;
  } catch {
    return "";
  }
}

// The app's own tokens (globals.css), inlined: these pages cannot load the stylesheet. The theme
// follows the OS rather than the in-app toggle, which lives in localStorage and needs a script.
const STYLE = `
:root{color-scheme:light dark;--paper:#ededed;--surface:#fff;--ink:#131313;--muted:#59595c;--faint:#8e8e91;--line:#e0e0e2;--anchor:#082773;--accent:#14abe3;--accent-2:#0e87b5;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--paper:#131313;--surface:#1a1c22;--ink:#ededed;--muted:#a5a7ad;--faint:#6d6f76;--line:#2b2e38;--anchor:#9db4e8;--accent:#2fbcf0;--accent-2:#6cd0f7;--accent-ink:#06202c}}
*{box-sizing:border-box}
body{margin:0;padding:48px 16px;background:var(--paper);color:var(--ink);font:14px/1.6 "Open Sans",Arial,system-ui,sans-serif}
main{max-width:520px;margin:0 auto;padding:28px 30px;background:var(--surface);border:1px solid var(--line);border-radius:14px}
h1{font-size:19px;line-height:1.35;font-weight:500;margin:0 0 8px;overflow-wrap:anywhere}
strong{font-weight:700}
p{margin:0 0 14px;color:var(--muted);overflow-wrap:anywhere}
.where{font:13px/1.5 ui-monospace,"JetBrains Mono",Consolas,monospace;color:var(--faint);margin:0 0 18px}
.fine{font-size:12.5px;color:var(--faint);margin:18px 0 0}
a{color:var(--anchor)}
.btn{display:inline-block;padding:9px 16px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none}
.btn:hover{background:var(--accent-2)}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
`.trim();

function page(opts: { title: string; head?: string; body: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Declared in the document so it holds even where an edge rewrites the Referrer-Policy header.
    '<meta name="referrer" content="no-referrer">',
    '<meta name="robots" content="noindex">',
    opts.head ?? "",
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<main>${opts.body}</main>`,
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

export type ConsentOutcome = "approve" | "deny";

/**
 * The hand-off page. `target` is the server-built redirect (the client's registered redirect_uri
 * plus `code`/`state`/`iss`, or `error=access_denied`); nothing in it comes from the form. It moves
 * on by itself at once, and shows a Continue link to the SAME url — the guaranteed path for a
 * browser with automatic refresh off, or an app scheme that wants a click.
 */
export function buildHandoffPage(opts: { clientName: string; target: string; outcome: ConsentOutcome }): string {
  if (!isSafeHandoffTarget(opts.target)) throw new Error("refusing to hand off to an unsafe redirect target");
  const target = escapeHtml(opts.target);
  const client = `<strong>${escapeHtml(opts.clientName)}</strong>`;
  const where = escapeHtml(describeTarget(opts.target));
  const lead =
    opts.outcome === "approve"
      ? `<h1>Returning you to ${client}</h1>\n<p class="where">${where}</p>\n<p>You approved this connection. skilly is sending you back so the client can finish connecting.</p>`
      : `<h1>You declined — nothing was authorized</h1>\n<p>Returning you to ${client}.</p>\n<p class="where">${where}</p>`;
  return page({
    title: `Returning you to ${opts.clientName} · skilly`,
    // Unquoted on purpose: everything after `url=` is the URL, so a `;` or `'` inside it is safe.
    head: `<meta http-equiv="refresh" content="0;url=${target}">`,
    body: [
      lead,
      `<p><a class="btn" href="${target}" rel="noreferrer">Continue</a></p>`,
      '<p class="fine">If this page stays open, use Continue.</p>',
    ].join("\n"),
  });
}

/** Every way the consent submit can fail (§29): status code + what the page says. */
export const CONSENT_FAILURES = {
  mcpDisabled: {
    status: 503,
    message: "A platform administrator has turned the MCP server off on this registry.",
  },
  signedOut: {
    status: 401,
    message: "You are signed out. Sign in to skilly, then start the connection again from your MCP client.",
  },
  notProvisioned: {
    status: 403,
    message: "Your account isn't provisioned in this registry yet — ask an administrator to check your directory sync.",
  },
  rateLimited: {
    status: 429,
    message: "Too many attempts. Wait a minute, then start the connection again from your MCP client.",
  },
  incomplete: {
    status: 400,
    message: "This connection request is incomplete. Start the connection again from your MCP client.",
  },
  // Cannot name the client: the lookup that failed is the one that would identify it, and a foreign
  // id must not reveal whose request it was.
  expired: {
    status: 400,
    message:
      "This connection request expired or was already answered. Start the connection again from your MCP client. " +
      "If you had already approved it, that approval gives the client nothing until it connects, and you can remove it on the MCP page.",
  },
  unknownClient: {
    status: 400,
    message: "This client is no longer registered. Start the connection again from your MCP client.",
  },
  blockedClient: {
    status: 403,
    message: "This client has been blocked by an administrator.",
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type ConsentFailure = keyof typeof CONSENT_FAILURES;

/** The consent error page: the reason, and a way back into skilly. It never sends anyone to a client. */
export function buildConsentErrorPage(message: string): string {
  return page({
    title: "Connection request can't be completed · skilly",
    body: [
      "<h1>This connection request can&rsquo;t be completed</h1>",
      `<p>${escapeHtml(message)}</p>`,
      '<p class="fine">Your connections are listed on the <a href="/mcp-server">MCP page</a>.</p>',
    ].join("\n"),
  });
}

/** Wrap one of the documents above. Never cacheable: the hand-off page carries an authorization code. */
export function consentPageResponse(html: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
