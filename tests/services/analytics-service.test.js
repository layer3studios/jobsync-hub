// FILE: tests/services/analytics-service.test.js
// Unit tests for the PostHog analytics service: init guard, parsing, typed errors,
// caching (hit / expiry / per-key), and key-secrecy. No DB, no real HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsService, AnalyticsQueryError } from '../../src/services/admin/analytics-service.js';

const KEY = 'phx_secret_test_key_123';
const SINCE = '2026-07-01T00:00:00.000Z';

// Builds a fake fetch that records calls and returns a canned response.
function fakeFetch({ ok = true, status = 200, results = [[42]] } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => ({ results }) };
  };
  impl.calls = calls;
  return impl;
}

function makeService(fetchImpl, cacheTtlMs = 300000) {
  return createAnalyticsService({
    posthogHost: 'https://eu.i.posthog.com',
    projectId: '228975',
    personalApiKey: KEY,
    cacheTtlMs,
    fetchImpl,
  });
}

test('init: missing personalApiKey throws a typed init error', () => {
  assert.throws(
    () => createAnalyticsService({ posthogHost: 'h', projectId: '1', personalApiKey: '' }),
    (err) => err instanceof AnalyticsQueryError && err.status === 503 && err.code === 'ANALYTICS_DISABLED',
  );
});

test('happy path: returns parsed results and hits the /query/ endpoint with a Bearer header', async () => {
  const fetchImpl = fakeFetch({ results: [[7]] });
  const svc = makeService(fetchImpl);
  const { results, cachedAt } = await svc.runNamed('visitors_total', SINCE);
  assert.deepEqual(results, [[7]]);
  assert.ok(typeof cachedAt === 'string');
  assert.match(fetchImpl.calls[0].url, /\/api\/projects\/228975\/query\/$/);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.query.kind, 'HogQLQuery');
});

test('non-2xx from PostHog throws AnalyticsQueryError carrying the status', async () => {
  const svc = makeService(fakeFetch({ ok: false, status: 429 }));
  await assert.rejects(
    () => svc.runNamed('visitors_total', SINCE),
    (err) => err instanceof AnalyticsQueryError && err.status === 429 && err.code === 'POSTHOG_QUERY_FAILED',
  );
});

test('cache hit within TTL does NOT call fetch a second time', async () => {
  const fetchImpl = fakeFetch();
  const svc = makeService(fetchImpl);
  await svc.runNamed('visitors_total', SINCE);
  await svc.runNamed('visitors_total', SINCE);
  assert.equal(fetchImpl.calls.length, 1);
});

test('cache miss after TTL calls fetch again', async () => {
  const fetchImpl = fakeFetch();
  const svc = makeService(fetchImpl, 5); // 5ms TTL
  await svc.runNamed('visitors_total', SINCE);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await svc.runNamed('visitors_total', SINCE);
  assert.equal(fetchImpl.calls.length, 2);
});

test('cache key is per-query per-since (different since = separate entry)', async () => {
  const fetchImpl = fakeFetch();
  const svc = makeService(fetchImpl);
  await svc.runNamed('visitors_total', SINCE);
  await svc.runNamed('visitors_total', '2026-06-01T00:00:00.000Z');
  await svc.runNamed('pageviews_total', SINCE);
  assert.equal(fetchImpl.calls.length, 3);
});

test('errors never contain the phx_ key value', async () => {
  // Network failure path (fetch throws) and non-2xx path both must stay clean.
  const throwing = async () => { throw new Error(`boom for ${KEY}`); };
  const svc = makeService(throwing);
  const netErr = await svc.runNamed('visitors_total', SINCE).catch((e) => e);
  assert.ok(netErr instanceof AnalyticsQueryError);
  assert.ok(!netErr.message.includes(KEY), 'network error message leaked the key');
  assert.ok(!String(netErr.stack).includes(KEY), 'network error stack leaked the key');

  const httpSvc = makeService(fakeFetch({ ok: false, status: 500 }));
  const httpErr = await httpSvc.runNamed('visitors_total', SINCE).catch((e) => e);
  assert.ok(!httpErr.message.includes(KEY), 'http error message leaked the key');
});
