// Shared Playwright fixtures for the skilly e2e suite. Every authed spec imports { test, expect,
// devSignIn } from here instead of re-implementing the next-auth credentials handshake.
//
// The suite runs against the DEV stack (SKILLY_DEV_AUTH=1): the server exposes a passwordless
// `dev` credentials provider that signs in the seeded `dev-admin-oid` platform admin
// (db/seed.dev.sql). It is NEVER present in production (auth.ts gates it on the env flag, and
// instrumentation.ts hard-fails a production boot that sets it).
import { test as base, expect, type Page } from "@playwright/test";

/**
 * Dev sign-in via the next-auth `dev` credentials callback (no form fields): fetch the CSRF
 * token, then POST the credentials callback. `page.request` shares the page's cookie jar, so
 * every subsequent page navigation AND `page.request` call is authenticated as the dev user.
 */
export async function devSignIn(page: Page): Promise<void> {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** `authedTest` — a `test` whose `page` is already signed in as the dev admin. Use it for specs
 *  that only ever act authenticated. Specs that also assert the signed-out state should import the
 *  plain `test` and call `devSignIn` explicitly at the point they want to be signed in. */
export const authedTest = base.extend<Record<string, never>>({
  page: async ({ page }, use) => {
    await devSignIn(page);
    await use(page);
  },
});

// Plain re-exports so a spec needs only this one import.
export const test = base;
export { expect, type Page };
