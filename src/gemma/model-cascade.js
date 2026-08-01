// FILE: src/gemma/model-cascade.js
// Model+key selection for one tier. Walks models in preference order and, for
// each, every key - skipping combos the rate tracker or circuit breaker already
// know are unusable, so a throttled combo costs nothing.
//
// The 429 distinction is the heart of this file:
//   quota exhausted (RESOURCE_EXHAUSTED / "quota") -> the DAY is gone for that
//     key+model; we mark the day spent and keep walking keys (a sibling key in
//     another GCP project may still have budget), then fall to the next model.
//   plain rate limit (RPM spike) -> transient; the next key on the SAME model
//     is very likely to work, so we stay on this model.
//
// TPM budgeting happens BEFORE the call: an oversized prompt is routed to a
// wider-TPM model rather than discovering the ceiling through a 429.
//
// generateContent() matches GemmaClient's signature, so callers swap one for
// the other without changing their call sites.

import { GemmaApiError } from './gemma-client.js';
import { estimateTokens } from './rate-limit-tracker.js';
import {
  recordUsageRequest, recordUsageCacheHit, recordUsageError, ERROR_BUCKETS,
} from './usage-stats.js';

const QUOTA_EXHAUSTED_PATTERN = /resource[_\s]?exhausted|quota/i;
const INVALID_KEY_PATTERN = /api key not valid/i;

const DEFAULT_STATS = {
  request: recordUsageRequest,
  cacheHit: recordUsageCacheHit,
  error: recordUsageError,
};

export class ModelCascade {
  constructor({
    models = [], keys = [], rateLimitTracker, circuitBreaker, responseCache,
    keyManager, client, tier = 'ai', stats = DEFAULT_STATS,
  } = {}) {
    this.models = models;
    this.keys = keys;
    this.rateLimitTracker = rateLimitTracker;
    this.circuitBreaker = circuitBreaker;
    this.responseCache = responseCache;
    this.keyManager = keyManager;
    this.client = client; // GemmaClient - owns the HTTP + response parsing
    this.tier = tier;
    // Injectable so unit tests never open a DB connection for telemetry.
    this.stats = stats;
  }

  /** Live keys only: a key the KeyManager blacklisted is never retried. */
  liveKeys() {
    if (!this.keyManager) return this.keys;
    return this.keys.filter((key) => !this.keyManager.dead.has(key));
  }

  /** This key's position in the configured list - stats never see key material. */
  keyIndexOf(apiKey) {
    const index = this.keys.indexOf(apiKey);
    return index === -1 ? 0 : index;
  }

  /** True when the API said the daily quota (not the per-minute rate) is gone. */
  static isQuotaExhausted(body) {
    return QUOTA_EXHAUSTED_PATTERN.test(String(body ?? ''));
  }

  /** Map one failure onto its stats bucket. */
  static errorBucket(err) {
    const status = err instanceof GemmaApiError ? err.status : err?.status;
    const body = err instanceof GemmaApiError ? err.body : err?.body;
    if (status === 429) {
      return ModelCascade.isQuotaExhausted(body)
        ? ERROR_BUCKETS.QUOTA_EXHAUSTED
        : ERROR_BUCKETS.RATE_LIMITED;
    }
    if (typeof status === 'number' && status >= 500) return ERROR_BUCKETS.SERVER_ERROR;
    return ERROR_BUCKETS.OTHER;
  }

  async generateContent(systemPrompt, userMessage, opts = {}) {
    const cacheKey = this.responseCache
      ? this.responseCache.hash(`${systemPrompt} ${userMessage}`)
      : null;
    if (cacheKey) {
      const hit = this.responseCache.get(cacheKey);
      if (hit !== null) {
        console.log(`[ai:${this.tier}] cache hit - no API call`);
        this.stats.cacheHit({ tier: this.tier, model: this.models[0] ?? 'unknown', apiKeyIndex: 0 });
        return hit;
      }
    }

    const estimatedTokens = estimateTokens(`${systemPrompt}${userMessage}`);

    for (const model of this.models) {
      for (const key of this.liveKeys()) {
        if (!this.rateLimitTracker.canMakeRequestWithTokens(key, model, estimatedTokens)) continue;
        if (!this.circuitBreaker.isAvailable(key, model)) continue;

        const identity = { tier: this.tier, model, apiKeyIndex: this.keyIndexOf(key) };
        try {
          const result = await this.client.generateContent(systemPrompt, userMessage, {
            ...opts, model, apiKey: key,
          });
          this.rateLimitTracker.recordRequestWithTokens(key, model, estimatedTokens);
          this.circuitBreaker.recordSuccess(key, model);
          this.stats.request(identity, estimatedTokens);
          if (cacheKey) this.responseCache.set(cacheKey, result);
          return result;
        } catch (err) {
          this.stats.error(identity, ModelCascade.errorBucket(err));
          this.handleFailure(err, key, model);
        }
      }
    }

    const summary = this.rateLimitTracker.summarize();
    console.warn(`[ai:${this.tier}] exhausted every model x key. Usage: ${summary}`);
    throw new Error(`[${this.tier}] All models rate-limited. Usage: ${summary}`);
  }

  /**
   * Classify one failure and update the breaker/tracker. Never rethrows - the
   * caller's loop simply advances to the next key or model.
   */
  handleFailure(err, key, model) {
    const status = err instanceof GemmaApiError ? err.status : err?.status;
    const body = err instanceof GemmaApiError ? err.body : err?.body;

    if (status === 429) {
      if (ModelCascade.isQuotaExhausted(body)) {
        // The day's quota for this key+model is spent - stop offering it today.
        this.rateLimitTracker.markDailyExhausted(key, model);
        console.log(`[ai:${this.tier}] daily quota exhausted: ${model}`);
        return;
      }
      // A per-minute spike: transient, so let the breaker count it and move on.
      this.circuitBreaker.recordFailure(key, model);
      return;
    }

    if (status === 400 && INVALID_KEY_PATTERN.test(String(body ?? ''))) {
      if (this.keyManager) this.keyManager.blacklistKey(key);
      console.warn(`[ai:${this.tier}] blacklisted an invalid API key`);
      return;
    }

    this.circuitBreaker.recordFailure(key, model);
    console.warn(`[ai:${this.tier}] ${model} failed (${status ?? 'unknown'}): ${err?.message ?? err}`);
  }
}

export default ModelCascade;
