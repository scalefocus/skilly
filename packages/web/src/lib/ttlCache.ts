// Tiny in-process TTL cache with in-flight de-duplication. Per-replica and short-lived by
// design — it only shaves *repeated* work within a short window; it is NOT a correctness layer.
// Cached values are either globally-derived (role mappings, leaderboard) or coalesce a single
// page's burst of identical requests, so a short TTL keeps staleness negligible.
type Entry<T> = { promise: Promise<T>; expires: number };

export interface TtlCache<T> {
  /** Return the cached value for `key`, or compute it via `load()` (de-duping concurrent loads). */
  get(key: string, load: () => Promise<T>): Promise<T>;
  delete(key: string): void;
  clear(): void;
}

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  const store = new Map<string, Entry<T>>();
  return {
    get(key, load) {
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.expires > now) return hit.promise;
      const promise = load();
      store.set(key, { promise, expires: now + ttlMs });
      // On failure, evict immediately so the next caller retries instead of caching the error.
      promise.catch(() => {
        if (store.get(key)?.promise === promise) store.delete(key);
      });
      return promise;
    },
    delete(key) { store.delete(key); },
    clear() { store.clear(); },
  };
}
