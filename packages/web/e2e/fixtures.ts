// Shared Playwright fixtures for the skilly e2e suite. Every authed spec imports { test, expect,
// devSignIn } from here instead of re-implementing the next-auth credentials handshake.
//
// The suite runs against the DEV stack (SKILLY_DEV_AUTH=1): the server exposes a passwordless
// `dev` credentials provider that signs in the seeded `dev-admin-oid` platform admin
// (db/seed.dev.sql). It is NEVER present in production (auth.ts gates it on the env flag, and
// instrumentation.ts hard-fails a production boot that sets it).
//
// Worker users (SKILLY_SPEC.md §16 item 18): the Jenkins run (ci/e2e-run.sh) sets
// E2E_WORKER_USERS=1 and runs several Playwright workers against ONE database, so each worker signs
// in as its own seeded platform admin, `e2e-worker-NN-oid` (db/seed.e2e.sql), where NN is the
// worker's parallelIndex + 1. Per-user state (installs, notifications, What's new marker, survey,
// onboarding) then never crosses between workers. A spec that needs the dev admin's own seed data
// passes `{ as: "dev-admin" }` and must be classified `group-dev-admin` in groups.ts. Without the
// variable (GitHub Actions, local runs) everyone is the dev admin, as before.
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { APP_VERSION } from "@skilly/shared/version";
import { e2eWorkerOid } from "../src/lib/devAuth";

/** Who `devSignIn` signs in as: the worker's own user, or the seeded dev admin. */
export type SignInAs = "worker" | "dev-admin";

/** The dev admin's entra_object_id (SKILLY_DEV_OID on the dev server, `dev-admin-oid` by default). */
export const DEV_ADMIN_OID = process.env.SKILLY_DEV_OID ?? "dev-admin-oid";

/**
 * The entra_object_id `devSignIn(page, { as })` signs in, for specs that read or reset their own
 * user's rows directly in the database. Call it inside a test or hook (it reads the worker index).
 */
export function signedInOid(as: SignInAs = "worker"): string {
  if (as === "dev-admin" || process.env.E2E_WORKER_USERS !== "1") return DEV_ADMIN_OID;
  return e2eWorkerOid(base.info().parallelIndex + 1);
}

/** The display name of the user `devSignIn(page, { as })` signs in, as seeded (db/seed.dev.sql,
 *  db/seed.e2e.sql), for assertions that name the signed-in user. Call it inside a test or hook. */
export function signedInDisplayName(as: SignInAs = "worker"): string {
  const worker = /^e2e-worker-(\d\d)-oid$/.exec(signedInOid(as));
  return worker ? `E2E Worker ${worker[1]}` : "Dev Admin";
}

const API_METHODS = ["fetch", "get", "head", "post", "put", "patch", "delete"] as const;

/**
 * Send every `context.request` (= `page.request`) call with `Connection: close`, so no API socket
 * is ever reused. Playwright's request client pools keep-alive sockets with no idle limit, while
 * `next dev` drops an idle socket after Node's 5 s `keepAliveTimeout` — and on a loaded agent that
 * timer fires late, in the same event-loop turn the next request's bytes land, so the server
 * destroys a socket holding an unread request and the kernel answers RST: `read ECONNRESET` on a
 * `page.request` issued after a few seconds of UI work. A fresh loopback connection per call
 * costs nothing next to that. Browser traffic is untouched.
 */
export function oneShotApiConnections(context: BrowserContext): void {
  type Call = (url: unknown, options?: { headers?: Record<string, string> }) => ReturnType<APIRequestContext["fetch"]>;
  const api = context.request as unknown as Record<(typeof API_METHODS)[number], Call>;
  for (const method of API_METHODS) {
    const send = api[method].bind(context.request);
    api[method] = (url, options = {}) => send(url, { ...options, headers: { connection: "close", ...options.headers } });
  }
}

/**
 * Dev sign-in via the next-auth `dev` credentials callback: fetch the CSRF token, then POST the
 * credentials callback naming the user to sign in (`signedInOid`: the worker's own user under
 * E2E_WORKER_USERS=1, else the dev admin). `page.request` shares the page's cookie jar, so every
 * subsequent page navigation AND `page.request` call is authenticated as that user.
 */
export async function devSignIn(
  page: Page,
  opts: { stampWhatsNew?: boolean; surveys?: boolean; as?: SignInAs } = {},
): Promise<void> {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true", oid: signedInOid(opts.as) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  // next-auth answers 200 with `{ url }` even when the credentials provider REJECTS — the failure
  // is encoded as an `?error=` in that url, so res.ok() alone cannot see it. Without this check a
  // refused sign-in stays silent here and resurfaces much later as an inscrutable "element not
  // found" against a page that quietly rendered its signed-out shell.
  const landing = (await res.json().catch(() => null)) as { url?: string } | null;
  expect(landing?.url ?? "", `dev sign-in was rejected: ${landing?.url ?? "(no url in response)"}`)
    .not.toMatch(/[?&]error=/);
  // Pre-stamp the What's new marker at the running version so the once-per-release update notice
  // (§23) never appears mid-spec and steals a click or a screenshot. whats-new-notice.spec.ts opts
  // out to exercise the notice itself. Forward-only, so this never hides a notice a spec seeded.
  if (opts.stampWhatsNew !== false) {
    await page.request.post("/api/me/whats-new-seen", { data: { version: APP_VERSION } });
  }
  // Opt the dev user out of the feedback survey (§36.14) so its card never lands mid-spec. The
  // survey spec opts back in (`surveys: true`) to exercise the card itself.
  if (opts.surveys !== true) {
    await page.request.patch("/api/me", { data: { surveysEnabled: false } });
  }
}

/** The suite's `test`: the built-in one with every test's `context` on one-shot API connections
 *  (see `oneShotApiConnections`). A spec that opens its own `browser.newContext()` and idles
 *  between `request` calls on it must apply the helper itself. */
// No type argument on either `extend`: both only OVERRIDE built-in fixtures and declare no new
// ones. `extend<Record<string, never>>` typed every fixture value as `never`, which made the
// override itself a type error (`Page` is not assignable to `never`).
export const test = base.extend({
  context: async ({ context }, use) => {
    oneShotApiConnections(context);
    await use(context);
  },
});

/** `authedTest` — a `test` whose `page` is already signed in (the worker's user, see above). Use it for specs
 *  that only ever act authenticated. Specs that also assert the signed-out state should import the
 *  plain `test` and call `devSignIn` explicitly at the point they want to be signed in. */
export const authedTest = test.extend({
  page: async ({ page }, use) => {
    await devSignIn(page);
    await use(page);
  },
});

// Plain re-exports so a spec needs only this one import.
export { expect, type Page };
