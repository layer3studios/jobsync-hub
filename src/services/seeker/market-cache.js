// FILE: src/services/seeker/market-cache.js
// Bounded, TTL'd in-process LRU for the seeker market services (D5, R4).
// Mirrors the marketPulse in-memory-cache trade-off: fine for a single MVP
// instance; Redis is the multi-instance upgrade (Watch). Time source is
// injectable (now) so tests advance the clock without real waits.
// Cache keys always embed the userId (C8) so a hit for user A can never
// surface for user B.

export const TTL_MILLISECONDS = 600_000;
export const MAX_ENTRIES = 500;

/** Create an isolated cache. Prefer the shared `marketCache` in app code. */
export function createMarketCache({
  now = Date.now,
  ttlMilliseconds = TTL_MILLISECONDS,
  maxEntries = MAX_ENTRIES,
} = {}) {
  // Map preserves insertion order → oldest key is first; a get re-inserts a
  // live entry to bump its recency (LRU).
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (now() - entry.storedAt >= ttlMilliseconds) {
      store.delete(key);
      return null;
    }
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    if (store.has(key)) {
      store.delete(key);
    } else if (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
    store.set(key, { value, storedAt: now() });
  }

  // Tests only — never called from request paths.
  function clear() {
    store.clear();
  }

  return { get, set, clear };
}

/** Shared singleton used by the match-count + salary-benchmark services. */
export const marketCache = createMarketCache();
