// Readiness helpers for the skilly e2e suite — the antidote to the suite's dominant flake.
//
// THE FLAKE: under `next dev` the server HTML arrives long before React hydrates, and on a loaded
// CI agent that gap is seconds. A spec that does `goto → expect(x).toBeVisible() → x.click()` passes
// its visibility check against the SERVER markup and then clicks a button with no handler attached
// yet. The click is silently dropped; nothing happens; the following assertion times out with an
// "unexpected value" that looks like a product bug. Toggles (watch, spotlight, collapse), pickers,
// dropdowns, hover cards and contentEditable composers all fail exactly this way.
//
// THE GATE: `Providers.tsx` mounts next-auth's SessionProvider with NO server session, so on the
// client `useSession()` starts "loading" and flips to "authenticated" only after the browser has
// hydrated AND fetched /api/auth/session. AppShell renders the topbar Notifications link only in
// that state — so its presence proves hydration is complete and event handlers are live. Every
// authed spec waits on it before its first interaction.
//
// THE SECOND RULE: never assert a mutation on a timer. Pair the click with the response it must
// produce (`clickAndAwait`) and assert AFTER the round-trip — deterministic on a fast box and a
// slow one alike.
import { expect, type Locator, type Page, type Response } from "@playwright/test";

/** Route compiles under `next dev` can be slow on first hit; the warm-up (global-setup.ts) takes
 *  most of that away, but the first spec to touch a route may still pay it. */
export const NAV_TIMEOUT = 45_000;

/** The one element that exists only after hydration + client session resolution (see header). */
export const shellReady = (page: Page): Locator => page.getByRole("link", { name: /^Notifications/ });

/**
 * Navigate and block until the app is INTERACTIVE — not merely painted. Use it instead of
 * `page.goto` in every authed spec (call devSignIn first).
 */
export async function gotoReady(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(shellReady(page)).toBeVisible({ timeout: NAV_TIMEOUT });
}

/**
 * `page.reload()` re-runs hydration from scratch — every readiness guarantee is void until the
 * shell is interactive again. Use this wherever a spec reloads and then interacts.
 */
export async function reloadReady(page: Page): Promise<void> {
  await page.reload();
  await expect(shellReady(page)).toBeVisible({ timeout: NAV_TIMEOUT });
}

/** URL matcher for a response: a string is a substring test, a RegExp is tested against the URL. */
export type UrlMatch = string | RegExp;

const matchUrl = (m: UrlMatch) => (r: Response) => (typeof m === "string" ? r.url().includes(m) : m.test(r.url()));

/**
 * Wait for an OK JSON response whose URL matches — the page's own `useApi` fetch (a plain
 * `fetch(url)`, so the URL is exactly what the component requested). Optional `method` narrows
 * to a mutation. Starts listening immediately; pair with an action via `clickAndAwait` when the
 * request is caused by that action.
 */
export function awaitApi(page: Page, url: UrlMatch, opts: { method?: string; timeout?: number } = {}): Promise<Response> {
  const isMatch = matchUrl(url);
  return page.waitForResponse(
    (r) => isMatch(r) && (!opts.method || r.request().method() === opts.method) && r.ok(),
    { timeout: opts.timeout ?? NAV_TIMEOUT },
  );
}

/**
 * Perform `action` (a click, a hover, a fill…) and resolve once the response it must trigger has
 * arrived OK. The listener is armed BEFORE the action, so a fast response can't be missed.
 */
export async function clickAndAwait(
  page: Page,
  action: () => Promise<void>,
  url: UrlMatch,
  opts: { method?: string; timeout?: number } = {},
): Promise<Response> {
  const [res] = await Promise.all([awaitApi(page, url, opts), action()]);
  return res;
}

/**
 * `gotoReady` + wait for the page's data request(s), so the first assertion runs against a
 * populated page rather than a skeleton. `dataUrl` is the `useApi` URL the page fetches on mount —
 * or several, when the spec needs the page's SECONDARY panels in too (a late-arriving panel above
 * the element under test shifts the layout, and layout shifts fire scroll events that dismiss
 * caret-anchored popups such as the mention picker).
 */
export async function gotoLoaded(page: Page, url: string, dataUrl: UrlMatch | UrlMatch[]): Promise<void> {
  const urls = Array.isArray(dataUrl) ? dataUrl : [dataUrl];
  const data = Promise.all(urls.map((u) => awaitApi(page, u)));
  await gotoReady(page, url);
  await data;
}

/**
 * Accept the next `window.confirm` — registered BEFORE the click that raises it. Returns a promise
 * that resolves when the dialog has actually been handled, so a test can prove the click landed
 * (a dropped pre-hydration click never opens a dialog).
 */
export function acceptNextDialog(page: Page): Promise<void> {
  return new Promise<void>((resolve) => {
    page.once("dialog", (d) => { void d.accept().then(resolve); });
  });
}

/** A per-run unique probe string — unique across retries too (retries re-run the body). */
export const probe = (label: string) => `e2e ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
