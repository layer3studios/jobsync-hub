// FILE: src/services/admin/analytics-service.js
// Server-side wrapper over PostHog's Query API (HogQL). Holds the personal API key
// (phx_), runs named queries from analytics-queries.js, and caches each result in an
// in-process Map with a TTL. The key is NEVER logged, put in an error message, or
// returned to a client (C8). Read-only — no writes to PostHog.

import { QUERIES } from './analytics-queries.js';

const DEFAULT_CACHE_TTL_MS = 300000; // 5 minutes (R8)

// Typed error. `query` (the query NAME, never the HogQL text or the key) is optional so
// tests can assert on it; the route layer strips it before responding to clients (D4).
export class AnalyticsQueryError extends Error {
  constructor(status, code, message, query) {
    super(message);
    this.name = 'AnalyticsQueryError';
    this.status = status;
    this.code = code;
    if (query) this.query = query;
  }
}

// Factory. Throws an init-time AnalyticsQueryError when the personal key is absent so a
// caller can decide to 503 rather than boot a half-configured service.
export function createAnalyticsService({
  posthogHost,
  projectId,
  personalApiKey,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  fetchImpl = fetch,
} = {}) {
  if (!personalApiKey) {
    throw new AnalyticsQueryError(503, 'ANALYTICS_DISABLED', 'Admin analytics is not configured.');
  }

  const endpoint = `${posthogHost}/api/projects/${projectId}/query/`;
  const cache = new Map(); // `${name}:${sinceISO}` → { results, cachedAtMs }

  async function callPostHog(hogql, queryName) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${personalApiKey}`,
        },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
      });
    } catch {
      // Network/DNS failure — never surface the key or the request internals.
      throw new AnalyticsQueryError(502, 'POSTHOG_UNREACHABLE', 'Could not reach the analytics provider.', queryName);
    }
    if (!response.ok) {
      throw new AnalyticsQueryError(response.status, 'POSTHOG_QUERY_FAILED', `Analytics query failed (${response.status}).`, queryName);
    }
    const body = await response.json();
    return Array.isArray(body?.results) ? body.results : [];
  }

  // Runs one named query for `sinceISO`, using the cache when a fresh entry exists.
  // Returns { results, cachedAt } — cachedAt is the ISO time the data was fetched.
  async function runNamed(queryName, sinceISO) {
    const build = QUERIES[queryName];
    if (!build) {
      throw new AnalyticsQueryError(500, 'UNKNOWN_QUERY', `Unknown analytics query: ${queryName}`, queryName);
    }
    const cacheKey = `${queryName}:${sinceISO}`;
    const now = Date.now();
    const hit = cache.get(cacheKey);
    if (hit && now - hit.cachedAtMs < cacheTtlMs) {
      return { results: hit.results, cachedAt: new Date(hit.cachedAtMs).toISOString() };
    }
    if (hit) cache.delete(cacheKey); // evict the stale entry on access (D6/6)

    const results = await callPostHog(build(sinceISO), queryName);
    cache.set(cacheKey, { results, cachedAtMs: now });
    return { results, cachedAt: new Date(now).toISOString() };
  }

  // Runs several named queries for the same `sinceISO`. Returns a map of
  // name → results plus the OLDEST cachedAt across them (most honest staleness signal).
  async function runMany(queryNames, sinceISO) {
    const settled = await Promise.all(queryNames.map((name) => runNamed(name, sinceISO)));
    const results = {};
    let oldestMs = Date.now();
    queryNames.forEach((name, index) => {
      results[name] = settled[index].results;
      oldestMs = Math.min(oldestMs, Date.parse(settled[index].cachedAt));
    });
    return { results, cachedAt: new Date(oldestMs).toISOString() };
  }

  return { runNamed, runMany, clearCache: () => cache.clear() };
}
