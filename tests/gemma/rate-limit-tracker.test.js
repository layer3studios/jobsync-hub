// FILE: tests/gemma/rate-limit-tracker.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimitTracker, pacificDateString } from '../../src/gemma/rate-limit-tracker.js';

const KEY_A = 'key-a';
const KEY_B = 'key-b';
// gemini-3.6-flash: rpm 5, rpd 20 → at 0.85 margin, floor(4.25)=4 rpm, 17 rpd.
const SMALL = 'gemini-3.6-flash';
// gemma-4-31b: rpm 30, rpd 14400 → 25 rpm, 12240 rpd.
const BIG = 'gemma-4-31b';

test('canMakeRequest is true when well under the limit', () => {
  const tracker = new RateLimitTracker(0.85);
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL), true);
  tracker.recordRequest(KEY_A, SMALL);
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL), true);
});

test('canMakeRequest goes false at 85% of the RPM limit', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) tracker.recordRequest(KEY_A, SMALL, now); // 4 == floor(5 * 0.85)
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, now), false);
  assert.deepEqual(tracker.getUsage(KEY_A, SMALL, now).rpm, { used: 4, limit: 5 });
});

test('canMakeRequest goes false at 85% of the RPD limit', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  const entry = tracker.entryFor(KEY_A, SMALL, now);
  entry.rpdCount = 17; // floor(20 * 0.85)
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, now), false);
});

test('the RPM window rolls forward after 60 seconds', () => {
  const tracker = new RateLimitTracker(0.85);
  const start = Date.now();
  for (let i = 0; i < 4; i += 1) tracker.recordRequest(KEY_A, SMALL, start);
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, start), false);
  // 61s later every timestamp has aged out of the rolling minute.
  const later = start + 61_000;
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, later), true);
  assert.equal(tracker.getUsage(KEY_A, SMALL, later).rpm.used, 0);
});

test('RPD resets when the Pacific calendar day changes', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  const entry = tracker.entryFor(KEY_A, SMALL, now);
  entry.rpdCount = 17;
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, now), false);
  // Cross the PT day boundary: the stored reset date is now stale.
  const tomorrow = now + 25 * 60 * 60 * 1000;
  assert.notEqual(pacificDateString(new Date(now)), pacificDateString(new Date(tomorrow)));
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, tomorrow), true);
  assert.equal(tracker.getUsage(KEY_A, SMALL, tomorrow).rpd.used, 0);
});

test('an unknown model falls back to conservative 5 rpm / 20 rpd', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  assert.deepEqual(tracker.getUsage(KEY_A, 'some-future-model', now).rpm.limit, 5);
  for (let i = 0; i < 4; i += 1) tracker.recordRequest(KEY_A, 'some-future-model', now);
  assert.equal(tracker.canMakeRequest(KEY_A, 'some-future-model', now), false);
});

test('per-key tracking: exhausting key A leaves key B usable on the same model', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) tracker.recordRequest(KEY_A, SMALL, now);
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, now), false);
  assert.equal(tracker.canMakeRequest(KEY_B, SMALL, now), true);
});

test('per-model tracking: exhausting a small model leaves a big one usable', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) tracker.recordRequest(KEY_A, SMALL, now);
  assert.equal(tracker.canMakeRequest(KEY_A, SMALL, now), false);
  assert.equal(tracker.canMakeRequest(KEY_A, BIG, now), true);
});

test('markDailyExhausted burns the day for that key+model only', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  tracker.markDailyExhausted(KEY_A, BIG, now);
  assert.equal(tracker.canMakeRequest(KEY_A, BIG, now), false);
  assert.equal(tracker.canMakeRequest(KEY_B, BIG, now), true);
});

test('getGlobalUsage and summarize aggregate across keys', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  tracker.recordRequest(KEY_A, BIG, now);
  tracker.recordRequest(KEY_B, BIG, now);
  const usage = tracker.getGlobalUsage(now);
  assert.equal(usage[BIG].rpdUsed, 2);
  assert.equal(usage[BIG].keys, 2);
  assert.match(tracker.summarize(now), /gemma-4-31b/);
});
