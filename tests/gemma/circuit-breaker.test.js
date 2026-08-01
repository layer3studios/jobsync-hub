// FILE: tests/gemma/circuit-breaker.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker, BREAKER_STATES } from '../../src/gemma/circuit-breaker.js';

const KEY = 'key-a';
const OTHER_KEY = 'key-b';
const MODEL = 'gemma-4-31b';
const OTHER_MODEL = 'gemini-3.6-flash';
const COOLDOWN_MS = 300_000;

const build = () => new CircuitBreaker({ failureThreshold: 3, cooldownMs: COOLDOWN_MS });

test('starts CLOSED and available', () => {
  const breaker = build();
  assert.equal(breaker.getState(KEY, MODEL), BREAKER_STATES.CLOSED);
  assert.equal(breaker.isAvailable(KEY, MODEL), true);
});

test('two failures do not open it; the third does', () => {
  const breaker = build();
  breaker.recordFailure(KEY, MODEL);
  breaker.recordFailure(KEY, MODEL);
  assert.equal(breaker.isAvailable(KEY, MODEL), true);
  breaker.recordFailure(KEY, MODEL);
  assert.equal(breaker.getState(KEY, MODEL), BREAKER_STATES.OPEN);
  assert.equal(breaker.isAvailable(KEY, MODEL), false);
});

test('a success before the threshold resets the failure count', () => {
  const breaker = build();
  breaker.recordFailure(KEY, MODEL);
  breaker.recordFailure(KEY, MODEL);
  breaker.recordSuccess(KEY, MODEL);
  breaker.recordFailure(KEY, MODEL);
  assert.equal(breaker.isAvailable(KEY, MODEL), true); // count restarted at 1
});

test('after the cooldown it becomes HALF_OPEN and allows one probe', () => {
  const breaker = build();
  const openedAt = Date.now();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure(KEY, MODEL, openedAt);
  assert.equal(breaker.isAvailable(KEY, MODEL, openedAt + COOLDOWN_MS - 1), false);
  assert.equal(breaker.isAvailable(KEY, MODEL, openedAt + COOLDOWN_MS), true);
  assert.equal(breaker.getState(KEY, MODEL), BREAKER_STATES.HALF_OPEN);
});

test('success while HALF_OPEN closes the circuit', () => {
  const breaker = build();
  const openedAt = Date.now();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure(KEY, MODEL, openedAt);
  breaker.isAvailable(KEY, MODEL, openedAt + COOLDOWN_MS); // → HALF_OPEN
  breaker.recordSuccess(KEY, MODEL);
  assert.equal(breaker.getState(KEY, MODEL), BREAKER_STATES.CLOSED);
  assert.equal(breaker.isAvailable(KEY, MODEL), true);
});

test('failure while HALF_OPEN re-opens immediately for another cooldown', () => {
  const breaker = build();
  const openedAt = Date.now();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure(KEY, MODEL, openedAt);
  const probeAt = openedAt + COOLDOWN_MS;
  breaker.isAvailable(KEY, MODEL, probeAt); // → HALF_OPEN
  breaker.recordFailure(KEY, MODEL, probeAt);
  assert.equal(breaker.getState(KEY, MODEL), BREAKER_STATES.OPEN);
  assert.equal(breaker.isAvailable(KEY, MODEL, probeAt + 1), false);
  // The cooldown restarts from the failed probe, not the original opening.
  assert.equal(breaker.isAvailable(KEY, MODEL, probeAt + COOLDOWN_MS), true);
});

test('key+model combos are independent', () => {
  const breaker = build();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure(KEY, MODEL);
  assert.equal(breaker.isAvailable(KEY, MODEL), false);
  assert.equal(breaker.isAvailable(OTHER_KEY, MODEL), true);   // same model, other key
  assert.equal(breaker.isAvailable(KEY, OTHER_MODEL), true);   // same key, other model
});
