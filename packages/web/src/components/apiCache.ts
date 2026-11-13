// Shared client-side cache for GET JSON, behind `useApi` / `useSharedApi` (components/ui.tsx).
// Kept free of React so its rules are unit-testable (apiCache.test.ts).
//
// It dedupes concurrent identical requests and serves a fresh-enough cached body to components that
// mount close together (e.g. several widgets all reading /api/me on one page) or across a quick
// navigation — instead of every caller firing its own request. The short TTL keeps it from masking
// real updates; a forced fetch always goes to the network.
//
// Subscribers: a component that must never disagree with another one reading the same URL
// subscribes, and every successful fetch of that URL — by anyone — is pushed to it. This is what
// keeps the sidebar's account bubble (mounted once, for the whole visit) showing the same level
// ring as the page's own bubble of the same person (SKILLY_SPEC.md §31.10).

export const API_TTL_MS = 5_000;

type Listener = (data: unknown) => void;

const apiCache = new Map<string, { data: unknown; ts: number }>();
const apiInflight = new Map<string, Promise<unknown>>();
const apiListeners = new Map<string, Set<Listener>>();

function publish(url: string, data: unknown): void {
  for (const fn of apiListeners.get(url) ?? []) fn(data);
}

export async function fetchJson(url: string, force: boolean): Promise<unknown> {
  if (force) {
    apiCache.delete(url);
    apiInflight.delete(url);
  } else {
    const cached = apiCache.get(url);
    if (cached && Date.now() - cached.ts < API_TTL_MS) return cached.data;
    const flight = apiInflight.get(url);
    if (flight) return flight;
  }
  const p = fetch(url)
    .then(async (r) => {
      if (r.status === 401) throw new Error("Sign in to view the registry.");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      return r.json();
    })
    .then((j) => {
      apiCache.set(url, { data: j, ts: Date.now() });
      publish(url, j);
      return j;
    })
    .finally(() => {
      if (apiInflight.get(url) === p) apiInflight.delete(url);
    });
  apiInflight.set(url, p);
  return p;
}

/** Invalidate a cached GET (call after a mutation that changes what `url` would return). */
export function invalidateApi(url: string): void {
  apiCache.delete(url);
  apiInflight.delete(url);
}

/** Refetch `url` now, bypassing the cache, and push the new body to every subscriber of it.
 *  Errors are swallowed: subscribers keep what they had. */
export function refreshApi(url: string): Promise<void> {
  return fetchJson(url, true).then(
    () => undefined,
    () => undefined,
  );
}

/** Receive every body fetched for `url` from now on, whoever fetched it. Returns the unsubscribe. */
export function subscribeApi(url: string, fn: Listener): () => void {
  let set = apiListeners.get(url);
  if (!set) {
    set = new Set();
    apiListeners.set(url, set);
  }
  set.add(fn);
  return () => {
    const cur = apiListeners.get(url);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) apiListeners.delete(url);
  };
}

/** Test-only: forget every cached body, in-flight request and subscriber. */
export function resetApiCacheForTests(): void {
  apiCache.clear();
  apiInflight.clear();
  apiListeners.clear();
}
