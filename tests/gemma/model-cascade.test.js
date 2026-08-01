// FILE: tests/gemma/model-cascade.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ModelCascade } from '../../src/gemma/model-cascade.js';
import { GemmaApiError } from '../../src/gemma/gemma-client.js';
import { RateLimitTracker } from '../../src/gemma/rate-limit-tracker.js';
import { CircuitBreaker } from '../../src/gemma/circuit-breaker.js';
import { ResponseCache } from '../../src/gemma/response-cache.js';
import { KeyManager } from '../../src/gemma/key-manager.js';

const MODELS = ['model-a', 'model-b', 'model-c'];
const KEYS = ['k1', 'k2'];

/** A stub client recording every (model, key) it was asked for. */
function stubClient(handler) {
  const calls = [];
  return {
    calls,
    async generateContent(_system, _user, opts) {
      calls.push({ model: opts.model, apiKey: opts.apiKey });
      return handler(opts, calls.length);
    },
  };
}

// No-op stats: telemetry must not drag a DB connection into a unit test.
const NO_STATS = { request() {}, cacheHit() {}, error() {} };

function build({ client, cache = null, keyManager = new KeyManager(KEYS.join(',')) } = {}) {
  return new ModelCascade({
    models: MODELS, keys: KEYS, keyManager, client,
    rateLimitTracker: new RateLimitTracker(0.85),
    circuitBreaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 }),
    responseCache: cache, tier: 'test', stats: NO_STATS,
  });
}

test('uses the first model and first key when everything is healthy', async () => {
  const client = stubClient(() => 'ok');
  const cascade = build({ client });
  assert.equal(await cascade.generateContent('sys', 'user'), 'ok');
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { model: 'model-a', apiKey: 'k1' });
});

test('rotates to the next KEY on the same model after a plain 429', async () => {
  const client = stubClient((opts) => {
    if (opts.apiKey === 'k1') throw new GemmaApiError(429, 'Too many requests per minute');
    return 'ok-from-k2';
  });
  const cascade = build({ client });
  assert.equal(await cascade.generateContent('sys', 'user'), 'ok-from-k2');
  assert.deepEqual(client.calls.map((c) => `${c.model}/${c.apiKey}`), ['model-a/k1', 'model-a/k2']);
});

test('falls through to the second model when the first is exhausted on all keys', async () => {
  const client = stubClient((opts) => {
    if (opts.model === 'model-a') throw new GemmaApiError(429, 'RESOURCE_EXHAUSTED: quota');
    return 'ok-model-b';
  });
  const cascade = build({ client });
  assert.equal(await cascade.generateContent('sys', 'user'), 'ok-model-b');
  assert.deepEqual(client.calls.map((c) => c.model), ['model-a', 'model-a', 'model-b']);
});

test('falls through to the third model when the first two are exhausted', async () => {
  const client = stubClient((opts) => {
    if (opts.model === 'model-c') return 'ok-model-c';
    throw new GemmaApiError(429, 'RESOURCE_EXHAUSTED: quota');
  });
  const cascade = build({ client });
  assert.equal(await cascade.generateContent('sys', 'user'), 'ok-model-c');
  assert.deepEqual([...new Set(client.calls.map((c) => c.model))], ['model-a', 'model-b', 'model-c']);
});

test('throws once every model × key is exhausted, with a usage summary', async () => {
  const client = stubClient(() => { throw new GemmaApiError(429, 'RESOURCE_EXHAUSTED: quota'); });
  const cascade = build({ client });
  await assert.rejects(
    cascade.generateContent('sys', 'user'),
    (err) => err.message.includes('All models rate-limited') && err.message.includes('Usage:'),
  );
  assert.equal(client.calls.length, MODELS.length * KEYS.length);
});

test('a cache hit skips the API entirely', async () => {
  const cache = new ResponseCache();
  const client = stubClient(() => 'fresh');
  const cascade = build({ client, cache });
  assert.equal(await cascade.generateContent('sys', 'user'), 'fresh');
  assert.equal(client.calls.length, 1);
  // Identical input: served from cache, no second call.
  assert.equal(await cascade.generateContent('sys', 'user'), 'fresh');
  assert.equal(client.calls.length, 1);
  // Different input still calls out.
  await cascade.generateContent('sys', 'other user');
  assert.equal(client.calls.length, 2);
});

test('an open circuit skips that key+model combo', async () => {
  const client = stubClient(() => 'ok');
  const cascade = build({ client });
  for (let i = 0; i < 3; i += 1) cascade.circuitBreaker.recordFailure('k1', 'model-a');
  await cascade.generateContent('sys', 'user');
  assert.deepEqual(client.calls[0], { model: 'model-a', apiKey: 'k2' }); // k1 skipped
});

test('a rate-limited key+model is skipped without an API call', async () => {
  const client = stubClient(() => 'ok');
  const cascade = build({ client });
  cascade.rateLimitTracker.markDailyExhausted('k1', 'model-a');
  await cascade.generateContent('sys', 'user');
  assert.deepEqual(client.calls[0], { model: 'model-a', apiKey: 'k2' });
});

test('quota-exhausted marks the day spent; a plain 429 does not', async () => {
  const quotaClient = stubClient(() => { throw new GemmaApiError(429, 'RESOURCE_EXHAUSTED'); });
  const quotaCascade = build({ client: quotaClient });
  await quotaCascade.generateContent('s', 'u').catch(() => {});
  assert.equal(quotaCascade.rateLimitTracker.canMakeRequest('k1', 'model-a'), false);

  const spikeClient = stubClient(() => { throw new GemmaApiError(429, 'Too many requests'); });
  const spikeCascade = build({ client: spikeClient });
  await spikeCascade.generateContent('s', 'u').catch(() => {});
  // The day is untouched; only the breaker counted failures.
  assert.equal(spikeCascade.rateLimitTracker.getUsage('k1', 'model-a').rpd.used, 0);
});

test('an invalid-key 400 blacklists the key and continues with the survivor', async () => {
  const keyManager = new KeyManager(KEYS.join(','));
  const client = stubClient((opts) => {
    if (opts.apiKey === 'k1') throw new GemmaApiError(400, 'API key not valid. Please pass a valid API key.');
    return 'ok-k2';
  });
  const cascade = build({ client, keyManager });
  assert.equal(await cascade.generateContent('sys', 'user'), 'ok-k2');
  assert.equal(keyManager.dead.has('k1'), true);
  assert.equal(keyManager.liveKeyCount(), 1);
});

test('a successful call records usage and closes the breaker', async () => {
  const client = stubClient(() => 'ok');
  const cascade = build({ client });
  await cascade.generateContent('sys', 'user');
  assert.equal(cascade.rateLimitTracker.getUsage('k1', 'model-a').rpd.used, 1);
  assert.equal(cascade.circuitBreaker.getState('k1', 'model-a'), 'CLOSED');
});
