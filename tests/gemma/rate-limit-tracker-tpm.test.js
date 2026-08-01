// FILE: tests/gemma/rate-limit-tracker-tpm.test.js
// Token-per-minute budgeting: the check that routes an oversized prompt to a
// wider-TPM model instead of earning a 429.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimitTracker, estimateTokens, MODEL_LIMITS } from '../../src/gemma/rate-limit-tracker.js';

const KEY = 'key-a';
const GEMMA = 'gemma-4-31b';        // tpm 16_000  -> 13_600 at 0.85
const GEMINI = 'gemini-3.6-flash';  // tpm 250_000 -> 212_500 at 0.85
const BIG_PROMPT_TOKENS = 10_000;

test('estimateTokens is length / 4, rounded up', () => {
  assert.equal(estimateTokens('12345678'), 2);   // 8 chars
  assert.equal(estimateTokens('123456789'), 3);  // 9 chars -> ceil(2.25)
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('x'.repeat(40_000)), 10_000);
  assert.equal(estimateTokens(null), 0); // never throws on missing input
});

test('every model carries a tpm limit', () => {
  for (const [model, limits] of Object.entries(MODEL_LIMITS)) {
    assert.ok(typeof limits.tpm === 'number' && limits.tpm > 0, `${model} needs a tpm`);
  }
});

test('canMakeRequestWithTokens is false when the prompt would exceed 85% of TPM', () => {
  const tracker = new RateLimitTracker(0.85);
  // 13_600 is the effective ceiling; 13_601 must not fit on an empty budget.
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, 13_600), true);
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, 13_601), false);
});

test('a 10k-token prompt against Gemma (16K TPM) allows only ONE call per minute', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();

  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, now), true);
  tracker.recordRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, now);

  // 10_000 + 10_000 = 20_000 > 13_600, so the second call cannot fit.
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, now), false);
  // Request-rate budget is untouched — TPM alone is the binding constraint.
  assert.equal(tracker.getUsage(KEY, GEMMA, now).rpm.used, 1);
  assert.equal(tracker.getUsage(KEY, GEMMA, now).tpm.used, 10_000);
});

test('the same 10k prompt against Gemini (250K TPM) allows many calls per minute', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  // Gemini's rpm (5 -> 4 effective) binds before its TPM does, so check TPM
  // headroom directly across many hypothetical calls.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMINI, BIG_PROMPT_TOKENS, now), true);
    tracker.recordRequestWithTokens(KEY, GEMINI, BIG_PROMPT_TOKENS, now);
  }
  assert.equal(tracker.getUsage(KEY, GEMINI, now).tpm.used, 40_000);
  // 40k spent of 212.5k — TPM still has room; only the RPM ceiling stops us.
  assert.ok(tracker.tokensInWindow(KEY, GEMINI, now) < 212_500);
});

test('the TPM window expires after 60 seconds', () => {
  const tracker = new RateLimitTracker(0.85);
  const start = Date.now();
  tracker.recordRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, start);
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, start), false);

  const later = start + 61_000;
  assert.equal(tracker.tokensInWindow(KEY, GEMMA, later), 0);
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, later), true);
});

test('TPM is tracked per key+model, not globally', () => {
  const tracker = new RateLimitTracker(0.85);
  const now = Date.now();
  tracker.recordRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, now);
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMMA, BIG_PROMPT_TOKENS, now), false);
  assert.equal(tracker.canMakeRequestWithTokens('key-b', GEMMA, BIG_PROMPT_TOKENS, now), true);
  assert.equal(tracker.canMakeRequestWithTokens(KEY, GEMINI, BIG_PROMPT_TOKENS, now), true);
});

test('exportState groups by model and reports key INDEXES, never key material', () => {
  const tracker = new RateLimitTracker(0.85);
  const keys = ['secret-key-0', 'secret-key-1'];
  const now = Date.now();
  tracker.recordRequestWithTokens(keys[0], GEMMA, 5_000, now);
  tracker.recordRequestWithTokens(keys[1], GEMMA, 1_000, now);

  const state = tracker.exportState(keys, now);
  const gemmaRow = state.models.find((row) => row.model === GEMMA);
  assert.deepEqual(gemmaRow.keys.map((k) => k.keyIndex), [0, 1]);
  assert.equal(gemmaRow.keys[0].tpm.used, 5_000);
  assert.equal(gemmaRow.keys[0].tpm.limit, 13_600); // margin applied
  assert.equal(gemmaRow.keys[0].exhausted, false);
  assert.ok(!JSON.stringify(state).includes('secret-key'), 'must never expose key material');
});

test('exportState flags an exhausted combo', () => {
  const tracker = new RateLimitTracker(0.85);
  const keys = ['k0'];
  const now = Date.now();
  tracker.markDailyExhausted('k0', GEMMA, now);
  const state = tracker.exportState(keys, now);
  assert.equal(state.models[0].keys[0].exhausted, true);
});
