// Shared Playwright fixtures for the skilly e2e suite. Every authed spec imports { test, expect,
// devSignIn } from here instead of re-implementing the next-auth credentials handshake.
//
// The suite runs against the DEV stack (SKILLY_DEV_AUTH=1): the server exposes a passwordless
// `dev` credentials provider that signs in the seeded `dev-admin-oid` platform admin
// (db/seed.dev.sql). It is NEVER present in production (auth.ts gates it on the env flag, and
// instrumentation.ts hard-fails a production boot that sets it).
import { test as base, expect, type Page } from "@playwright/test";
import { APP_VERSION } from "@skilly/shared/version";

/**
 * Dev sign-in via the next-auth `dev` credentials callback (no form fields): fetch the CSRF
 * token, then POST the credentials callback. `page.request` shares the page's cookie jar, so
 * every subsequent page navigation AND `page.request` call is authenticated as the dev user.
 */
export async function devSignIn(page: Page, opts: { stampWhatsNew?: boolean; surveys?: boolean } = {}): Promise<void> {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
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

/** `authedTest` — a `test` whose `page` is already signed in as the dev admin. Use it for specs
 *  that only ever act authenticated. Specs that also assert the signed-out state should import the
 *  plain `test` and call `devSignIn` explicitly at the point they want to be signed in. */
// No type argument: this only OVERRIDES the built-in `page` fixture and declares no new ones.
// `extend<Record<string, never>>` typed every fixture value as `never`, which made the `page`
// override itself a type error (`Page` is not assignable to `never`).
export const authedTest = base.extend({
  page: async ({ page }, use) => {
    await devSignIn(page);
    await use(page);
  },
});

// Plain re-exports so a spec needs only this one import.
export const test = base;
export { expect, type Page };
