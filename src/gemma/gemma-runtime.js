// FILE: src/gemma/gemma-runtime.js
// Process-wide singletons for the Gemma stack. initGemma() is called once on boot
// (server.js). Two independent key pools serve two workload classes (R2):
//
//   scoring (real-time) — applicant scoring, resume parse/review, employer JD extract
//   scraper (batch)     — scrape-pass JD extraction, bursty, dozens-to-hundreds of calls
//
// Each pool owns its KeyManager, so rate limits, blacklists and quota exhaustion in
// one never starve the other. Keys should come from DIFFERENT GCP projects for the
// isolation to be real — same-project keys share a quota bucket (R1).
//
// When the scraper pool is empty, getScraperGemmaClient() falls back to the scoring
// client. That makes deploying this file a behavioural no-op until
// GEMMA_SCRAPER_API_KEYS is actually set in the environment (C8a, C9).

import { GEMMA_API_KEYS, GEMMA_SCRAPER_API_KEYS, GEMMA_MODEL, GEMMA_BASE_URL } from '../env.js';
import { KeyManager } from './key-manager.js';
import { GemmaClient } from './gemma-client.js';

let scoringKeyManager = null;
let scoringClient = null;
let scraperKeyManager = null;
let scraperClient = null;

/** A client for this pool, or null when the pool has no live keys. */
function buildClient(keyManager) {
  if (!keyManager.hasLiveKeys()) return null;
  return new GemmaClient({ keyManager, model: GEMMA_MODEL, baseUrl: GEMMA_BASE_URL });
}

/** One line, once per initGemma(). Counts only — never key material (C12). */
function logPoolStatus(scoringLiveKeys, scraperLiveKeys, scraperUsesFallback) {
  if (scoringLiveKeys === 0 && scraperLiveKeys === 0) {
    console.log('[gemma] Initialized — no keys configured; extraction and scoring disabled');
  } else if (scraperUsesFallback) {
    console.log(`[gemma] Initialized — scoring pool: ${scoringLiveKeys} live keys, scraper pool: fallback (set GEMMA_SCRAPER_API_KEYS to isolate)`);
  } else {
    console.log(`[gemma] Initialized — scoring pool: ${scoringLiveKeys} live keys, scraper pool: ${scraperLiveKeys} live keys`);
  }
}

/**
 * Build both singleton pools from env (or explicit key strings, for tests).
 * Both parameters are optional, so initGemma() keeps its old zero-arg contract (C8c).
 * Returns { scoringLiveKeys, scraperLiveKeys, scraperUsesFallback }.
 */
export function initGemma(scoringKeysString = GEMMA_API_KEYS, scraperKeysString = GEMMA_SCRAPER_API_KEYS) {
  scoringKeyManager = new KeyManager(scoringKeysString);
  scoringClient = buildClient(scoringKeyManager);

  scraperKeyManager = new KeyManager(scraperKeysString);
  scraperClient = buildClient(scraperKeyManager);

  const scoringLiveKeys = scoringKeyManager.liveKeyCount();
  const scraperLiveKeys = scraperKeyManager.liveKeyCount();
  const scraperUsesFallback = scraperLiveKeys === 0;

  logPoolStatus(scoringLiveKeys, scraperLiveKeys, scraperUsesFallback);
  return { scoringLiveKeys, scraperLiveKeys, scraperUsesFallback };
}

/** The real-time pool client, or null when no scoring keys are configured. */
export function getScoringGemmaClient() {
  return scoringClient;
}

/**
 * The batch pool client. Falls back to the scoring client when the scraper pool
 * has no live keys — so this returns null only when BOTH pools are empty (C9).
 */
export function getScraperGemmaClient() {
  return scraperClient ?? scoringClient;
}

/** Deprecated: use getScoringGemmaClient() explicitly. Kept for backward compat (C8b). */
export function getGemmaClient() {
  return getScoringGemmaClient();
}

export function getScoringKeyManager() {
  return scoringKeyManager;
}

export function getScraperKeyManager() {
  return scraperKeyManager;
}

/** Deprecated: use getScoringKeyManager() explicitly. Kept for backward compat. */
export function getKeyManager() {
  return getScoringKeyManager();
}
