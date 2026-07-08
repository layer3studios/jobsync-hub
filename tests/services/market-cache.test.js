import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMarketCache, TTL_MILLISECONDS } from '../../src/services/seeker/market-cache.js';

test('set/get round-trip', () => {
  const cache = createMarketCache();
  cache.set('k', { count: 5 });
  assert.deepEqual(cache.get('k'), { count: 5 });
  assert.equal(cache.get('missing'), null);
});

test('entries expire after the TTL (injected clock)', () => {
  let clock = 1000;
  const cache = createMarketCache({ now: () => clock });
  cache.set('k', 'v');
  clock += TTL_MILLISECONDS - 1;
  assert.equal(cache.get('k'), 'v');
  clock += 2; // now past the TTL
  assert.equal(cache.get('k'), null);
});

test('LRU evicts the oldest at MAX_ENTRIES', () => {
  const cache = createMarketCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // evicts 'a'
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('a get bumps recency so the touched key survives eviction', () => {
  const cache = createMarketCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'a' is now most-recent → 'b' is oldest
  cache.set('c', 3); // evicts 'b'
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), null);
});

test('userId-scoped keys never collide across users', () => {
  const cache = createMarketCache();
  cache.set('match:userA:', { count: 1 });
  cache.set('match:userB:', { count: 99 });
  assert.equal(cache.get('match:userA:').count, 1);
  assert.equal(cache.get('match:userB:').count, 99);
});
