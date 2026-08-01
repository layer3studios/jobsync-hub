// FILE: tests/gemma/response-cache.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ResponseCache, hashScoringInput } from '../../src/gemma/response-cache.js';

test('a miss returns null', () => {
  const cache = new ResponseCache();
  assert.equal(cache.get(cache.hash('nothing stored')), null);
});

test('a hit returns exactly what was stored', () => {
  const cache = new ResponseCache();
  const key = cache.hash('some jd text');
  cache.set(key, { skills: ['react'] });
  assert.deepEqual(cache.get(key), { skills: ['react'] });
});

test('the same input always hashes the same', () => {
  const cache = new ResponseCache();
  assert.equal(cache.hash('identical input'), cache.hash('identical input'));
  assert.match(cache.hash('x'), /^[a-f0-9]{64}$/); // sha-256 hex
});

test('different inputs hash differently', () => {
  const cache = new ResponseCache();
  assert.notEqual(cache.hash('jd one'), cache.hash('jd two'));
});

test('LRU eviction: the 1001st entry evicts the oldest', () => {
  const cache = new ResponseCache(1000);
  for (let i = 0; i < 1000; i += 1) cache.set(cache.hash(`item-${i}`), i);
  assert.equal(cache.size, 1000);
  const oldest = cache.hash('item-0');
  assert.equal(cache.get(oldest), 0);

  // get() promoted item-0, so item-1 is now the least recently used.
  cache.set(cache.hash('item-1000'), 1000);
  assert.equal(cache.size, 1000);
  assert.equal(cache.get(cache.hash('item-1')), null); // evicted
  assert.equal(cache.get(oldest), 0);                  // survived via promotion
});

test('scoring inputs: same resume + same JD hits, either side differing misses', () => {
  const cache = new ResponseCache();
  const requirements = { mustHave: ['react'] };
  const otherRequirements = { mustHave: ['go'] };

  const key = hashScoringInput(cache, 'RESUME TEXT A', requirements);
  cache.set(key, { score: 82 });

  // Identical resubmission (same candidate, second posting sharing the JD).
  assert.deepEqual(cache.get(hashScoringInput(cache, 'RESUME TEXT A', requirements)), { score: 82 });
  // Different resume, same JD.
  assert.equal(cache.get(hashScoringInput(cache, 'RESUME TEXT B', requirements)), null);
  // Same resume, different JD.
  assert.equal(cache.get(hashScoringInput(cache, 'RESUME TEXT A', otherRequirements)), null);
});

test('JD extraction inputs cache on the stripped text', () => {
  const cache = new ResponseCache();
  const key = cache.hash('Senior React Developer. Must have 5 years.');
  cache.set(key, { skills: ['react'] });
  assert.deepEqual(cache.get(cache.hash('Senior React Developer. Must have 5 years.')), { skills: ['react'] });
});
