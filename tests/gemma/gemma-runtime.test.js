// FILE: tests/gemma/gemma-runtime.test.js
// Dual key pools: scoring (real-time) vs scraper (batch). Covers construction,
// the empty-scraper-pool fallback (C9), back-compat aliases (C8b/C8c), quota
// independence, and the boot log wording (C10). No DB, no HTTP.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initGemma, getGemmaClient, getKeyManager,
  getScoringGemmaClient, getScraperGemmaClient,
  getScoringKeyManager, getScraperKeyManager,
} from '../../src/gemma/gemma-runtime.js';

/** Run fn with console.log captured; returns its emitted lines and return value. */
function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let value;
  try {
    value = fn();
  } finally {
    console.log = original;
  }
  return { lines, value };
}

/** initGemma() without the boot log polluting test output; returns its result. */
const initQuietly = (...args) => captureLog(() => initGemma(...args)).value;
const logLinesFor = (...args) => captureLog(() => initGemma(...args)).lines;

afterEach(() => { initQuietly('', ''); }); // leave no client behind for other files

test('both pools configured → two distinct clients over two distinct key managers', () => {
  const result = initQuietly('scoring-1,scoring-2', 'scraper-1');
  assert.deepEqual(result, { scoringLiveKeys: 2, scraperLiveKeys: 1, scraperUsesFallback: false });

  const scoring = getScoringGemmaClient();
  const scraper = getScraperGemmaClient();
  assert.ok(scoring && scraper);
  assert.notEqual(scoring, scraper, 'pools must not share a client');
  assert.notEqual(getScoringKeyManager(), getScraperKeyManager());
  assert.equal(getScoringKeyManager().totalKeyCount(), 2);
  assert.equal(getScraperKeyManager().totalKeyCount(), 1);
});

// C9 — the deploy-is-a-no-op guarantee.
test('empty scraper pool → getScraperGemmaClient returns the SAME instance as scoring', () => {
  const result = initQuietly('scoring-1', '');
  assert.equal(result.scraperUsesFallback, true);
  assert.equal(result.scraperLiveKeys, 0);
  assert.equal(getScraperGemmaClient(), getScoringGemmaClient());
  assert.ok(getScraperGemmaClient());
});

test('whitespace-only scraper keys are treated as empty → fallback', () => {
  const result = initQuietly('scoring-1', '  ,  , ');
  assert.equal(result.scraperUsesFallback, true);
  assert.equal(getScraperGemmaClient(), getScoringGemmaClient());
});

test('both pools empty → every getter returns null (Gemma entirely off)', () => {
  const result = initQuietly('', '');
  assert.deepEqual(result, { scoringLiveKeys: 0, scraperLiveKeys: 0, scraperUsesFallback: true });
  assert.equal(getScoringGemmaClient(), null);
  assert.equal(getScraperGemmaClient(), null);
  assert.equal(getGemmaClient(), null);
});

test('scraper-only keys → scoring is null, scraper client still built', () => {
  const result = initQuietly('', 'scraper-1');
  assert.equal(result.scoringLiveKeys, 0);
  assert.equal(result.scraperUsesFallback, false);
  assert.equal(getScoringGemmaClient(), null);
  assert.ok(getScraperGemmaClient());
});

// C8b/C8c — nothing that used the old API breaks.
test('getGemmaClient and getKeyManager remain aliases of the scoring pool', () => {
  initQuietly('scoring-1', 'scraper-1');
  assert.equal(getGemmaClient(), getScoringGemmaClient());
  assert.equal(getKeyManager(), getScoringKeyManager());
  assert.notEqual(getGemmaClient(), getScraperGemmaClient());
});

test('initGemma() with one argument keeps its old contract', () => {
  const result = initQuietly('only-scoring-key');
  assert.equal(result.scoringLiveKeys, 1);
  assert.ok(getGemmaClient());
});

// The whole point of the split: exhausting one pool must not disable the other.
test('blacklisting every scoring key leaves the scraper pool live, and vice versa', () => {
  initQuietly('scoring-1', 'scraper-1');
  getScoringKeyManager().blacklistKey('scoring-1');
  assert.equal(getScoringKeyManager().hasLiveKeys(), false);
  assert.equal(getScraperKeyManager().hasLiveKeys(), true);
  assert.equal(getScraperKeyManager().getNextKey(), 'scraper-1');

  initQuietly('scoring-1', 'scraper-1');
  getScraperKeyManager().blacklistKey('scraper-1');
  assert.equal(getScraperKeyManager().hasLiveKeys(), false);
  assert.equal(getScoringKeyManager().getNextKey(), 'scoring-1');
});

// C10 + C12 — exact wording, and never any key material.
test('boot log reports both pool sizes when both are configured', () => {
  assert.deepEqual(logLinesFor('a,b', 'c'), [
    '[gemma] Initialized — scoring pool: 2 live keys, scraper pool: 1 live keys',
  ]);
});

test('boot log names the fallback when only scoring is configured', () => {
  assert.deepEqual(logLinesFor('a', ''), [
    '[gemma] Initialized — scoring pool: 1 live keys, scraper pool: fallback (set GEMMA_SCRAPER_API_KEYS to isolate)',
  ]);
});

test('boot log reports the disabled state when no keys exist', () => {
  assert.deepEqual(logLinesFor('', ''), [
    '[gemma] Initialized — no keys configured; extraction and scoring disabled',
  ]);
});

test('boot log emits exactly one line and never leaks key material', () => {
  const lines = logLinesFor('super-secret-scoring', 'super-secret-scraper');
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /super-secret/);
});
