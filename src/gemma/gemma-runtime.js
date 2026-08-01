// FILE: src/gemma/gemma-runtime.js
// Process-wide AI singletons. initGemma() is called once on boot (server.js).
//
// Three TIERS share one key pool but get their own model cascade, so the
// employer path can lead with the strongest models while seeker and scraper
// lead with the high-quota Gemma tiers. Rate tracking, circuit breaking and the
// response cache are shared across tiers — they are properties of the upstream
// API, not of our callers, so a key burned by the scraper must be visible to
// the employer path immediately.
//
// BACKWARD COMPAT: with only GEMMA_API_KEYS (and optionally GEMMA_MODEL) set,
// every tier gets the same keys and the default cascades, and the legacy
// getScoringGemmaClient()/getScraperGemmaClient()/getGemmaClient() accessors
// keep working. GEMMA_SCRAPER_API_KEYS, when set, still isolates scraper keys.

import {
  GEMMA_API_KEYS, GEMMA_SCRAPER_API_KEYS, GEMMA_MODEL, GEMMA_BASE_URL,
  EMPLOYER_AI_MODELS, SEEKER_AI_MODELS, SCRAPER_AI_MODELS,
  AI_SAFETY_MARGIN, SCRAPER_JD_EXTRACTION_ENABLED,
} from '../env.js';
import { KeyManager } from './key-manager.js';
import { GemmaClient } from './gemma-client.js';
import { RateLimitTracker } from './rate-limit-tracker.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ResponseCache } from './response-cache.js';
import { ModelCascade } from './model-cascade.js';

const RESPONSE_CACHE_SIZE = 1000;

const parseList = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

let rateLimitTracker = null;
let circuitBreaker = null;
let responseCache = null;
let employerCascade = null;
let seekerCascade = null;
let scraperCascade = null;
let scoringKeyManager = null;
let scraperKeyManager = null;

/** One cascade over a key pool, or null when that pool has no live keys. */
function buildCascade({ models, keyManager, tier }) {
  if (!keyManager.hasLiveKeys()) return null;
  // GEMMA_MODEL stays the client's default so a legacy single-model .env still
  // drives the URL when a cascade entry is somehow absent.
  const client = new GemmaClient({ keyManager, model: GEMMA_MODEL, baseUrl: GEMMA_BASE_URL });
  return new ModelCascade({
    models: models.length > 0 ? models : [GEMMA_MODEL],
    keys: keyManager.keys,
    keyManager, client, rateLimitTracker, circuitBreaker, responseCache, tier,
  });
}

function logTier(tier, cascade, disabledReason) {
  if (disabledReason) {
    console.log(`[ai] ${tier} tier: DISABLED (${disabledReason})`);
    return;
  }
  if (!cascade) {
    console.log(`[ai] ${tier} tier: DISABLED (no API keys configured)`);
    return;
  }
  const combos = cascade.models.length * cascade.keys.length;
  console.log(`[ai] ${tier} tier: ${cascade.models.length} models × ${cascade.keys.length} keys = ${combos} combos`);
}

/**
 * Build every singleton from env (or explicit key strings, for tests).
 * Returns { scoringLiveKeys, scraperLiveKeys, scraperUsesFallback } — the same
 * shape the previous implementation returned, so callers are unchanged.
 */
export function initGemma(scoringKeysString = GEMMA_API_KEYS, scraperKeysString = GEMMA_SCRAPER_API_KEYS) {
  rateLimitTracker = new RateLimitTracker(AI_SAFETY_MARGIN);
  circuitBreaker = new CircuitBreaker();
  responseCache = new ResponseCache(RESPONSE_CACHE_SIZE);

  scoringKeyManager = new KeyManager(scoringKeysString);
  scraperKeyManager = new KeyManager(scraperKeysString);

  employerCascade = buildCascade({ models: parseList(EMPLOYER_AI_MODELS), keyManager: scoringKeyManager, tier: 'employer' });
  seekerCascade = buildCascade({ models: parseList(SEEKER_AI_MODELS), keyManager: scoringKeyManager, tier: 'seeker' });
  // The scraper prefers its own pool; with none configured it shares the main
  // pool, exactly as the previous fallback did.
  const scraperPool = scraperKeyManager.hasLiveKeys() ? scraperKeyManager : scoringKeyManager;
  scraperCascade = buildCascade({ models: parseList(SCRAPER_AI_MODELS), keyManager: scraperPool, tier: 'scraper' });

  const scoringLiveKeys = scoringKeyManager.liveKeyCount();
  const scraperLiveKeys = scraperKeyManager.liveKeyCount();

  logTier('employer', employerCascade);
  logTier('seeker', seekerCascade);
  logTier('scraper', scraperCascade, SCRAPER_JD_EXTRACTION_ENABLED ? null : 'SCRAPER_JD_EXTRACTION_ENABLED=false');

  return { scoringLiveKeys, scraperLiveKeys, scraperUsesFallback: scraperLiveKeys === 0 };
}

export function getEmployerAiClient() {
  return employerCascade;
}

export function getSeekerAiClient() {
  return seekerCascade;
}

/** Null when extraction is switched off, so callers need no separate flag check. */
export function getScraperAiClient() {
  if (!SCRAPER_JD_EXTRACTION_ENABLED) return null;
  return scraperCascade;
}

/**
 * Live per-model/per-key budget snapshot for the admin dashboard. Reports key
 * INDEXES, never key material. Null before initGemma() has run.
 */
export function getAiUsageSnapshot() {
  if (!rateLimitTracker) return null;
  const keys = scoringKeyManager ? scoringKeyManager.keys : [];
  const scraperKeys = scraperKeyManager ? scraperKeyManager.keys : [];
  // One index space across both pools, so a scraper-only key still resolves.
  const allKeys = [...keys, ...scraperKeys.filter((key) => !keys.includes(key))];
  return rateLimitTracker.exportState(allKeys);
}

// ─── Shared instrumentation (exported for logging / tests) ─────────
export const getRateLimitTracker = () => rateLimitTracker;
export const getCircuitBreaker = () => circuitBreaker;
export const getResponseCache = () => responseCache;

// ─── Backward-compatible accessors ─────────────────────────────────
/** Deprecated: use getEmployerAiClient(). */
export function getScoringGemmaClient() {
  return getEmployerAiClient();
}

/** Deprecated: use getScraperAiClient(). */
export function getScraperGemmaClient() {
  return getScraperAiClient();
}

/** Deprecated: use getEmployerAiClient(). */
export function getGemmaClient() {
  return getEmployerAiClient();
}

export function getScoringKeyManager() {
  return scoringKeyManager;
}

export function getScraperKeyManager() {
  return scraperKeyManager;
}

/** Deprecated: use getScoringKeyManager(). */
export function getKeyManager() {
  return getScoringKeyManager();
}
