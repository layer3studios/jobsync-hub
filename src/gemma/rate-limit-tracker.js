// FILE: src/gemma/rate-limit-tracker.js
// Client-side usage accounting per (key, model), so the cascade can skip a
// combo BEFORE spending a request to discover it is throttled. Pure in-memory:
// a restart forgets usage, which is safe — the server-side limit is still the
// real authority and a 429 is handled either way.
//
// RPD resets on the Pacific-time calendar day, because that is the day
// boundary Google's free-tier quotas use.

import { buildUsageSnapshot } from './rate-limit-snapshot.js';

const CONSERVATIVE_LIMIT = { rpm: 5, rpd: 20, tpm: 16000 };
const RPM_WINDOW_MS = 60_000;
const CHARS_PER_TOKEN = 4;

export const MODEL_LIMITS = {
  'gemini-3.6-flash': { rpm: 5, rpd: 20, tpm: 250000 },
  'gemini-3.5-flash': { rpm: 5, rpd: 20, tpm: 250000 },
  'gemini-3-flash': { rpm: 5, rpd: 20, tpm: 250000 },
  'gemini-2.5-flash': { rpm: 5, rpd: 20, tpm: 250000 },
  'gemini-3.5-flash-lite': { rpm: 15, rpd: 500, tpm: 250000 },
  'gemini-3.1-flash-lite': { rpm: 15, rpd: 500, tpm: 250000 },
  'gemini-2.5-flash-lite': { rpm: 10, rpd: 20, tpm: 250000 },
  'gemma-4-26b-a4b-it': { rpm: 30, rpd: 14400, tpm: 16000 },
  'gemma-4-31b': { rpm: 30, rpd: 14400, tpm: 16000 },
};

/**
 * ~4 characters per token is the standard English-text approximation. No
 * tokenizer dependency: this is a budgeting guard, not billing. Rounding UP
 * (ceil) keeps the error on the safe side — overcounting stops us early, while
 * undercounting would earn a real 429.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

/** Today's date in Pacific Time as YYYY-MM-DD — the quota reset boundary. */
export function pacificDateString(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export const limitsForModel = (model) => MODEL_LIMITS[model] ?? CONSERVATIVE_LIMIT;

export class RateLimitTracker {
  constructor(safetyMargin = 0.85) {
    this.safetyMargin = safetyMargin;
    this.usage = new Map();
  }

  static entryKey(apiKey, model) {
    return `${apiKey}::${model}`;
  }

  /** Get-or-create the entry, rolling the RPD counter over at the PT day boundary. */
  entryFor(apiKey, model, now = Date.now()) {
    const key = RateLimitTracker.entryKey(apiKey, model);
    let entry = this.usage.get(key);
    if (!entry) {
      entry = {
        rpmTimestamps: [], tpmTokens: [], rpdCount: 0, rpdResetDate: pacificDateString(new Date(now)),
      };
      this.usage.set(key, entry);
    }
    const today = pacificDateString(new Date(now));
    if (entry.rpdResetDate !== today) {
      entry.rpdCount = 0;
      entry.rpdResetDate = today;
    }
    // Drop entries that have aged out of the rolling minute.
    entry.rpmTimestamps = entry.rpmTimestamps.filter((stamp) => now - stamp < RPM_WINDOW_MS);
    entry.tpmTokens = entry.tpmTokens.filter((row) => now - row.timestamp < RPM_WINDOW_MS);
    return entry;
  }

  /** The effective ceiling: the published limit scaled by the safety margin. */
  effectiveLimits(model) {
    const { rpm, rpd, tpm } = limitsForModel(model);
    return {
      rpm: Math.floor(rpm * this.safetyMargin),
      rpd: Math.floor(rpd * this.safetyMargin),
      tpm: Math.floor(tpm * this.safetyMargin),
    };
  }

  /** Tokens spent in the trailing minute for this key+model. */
  tokensInWindow(apiKey, model, now = Date.now()) {
    return this.entryFor(apiKey, model, now).tpmTokens.reduce((sum, row) => sum + row.tokens, 0);
  }

  canMakeRequest(apiKey, model, now = Date.now()) {
    return this.canMakeRequestWithTokens(apiKey, model, 0, now);
  }

  /**
   * Would this request fit? Checks the request-rate ceilings AND whether the
   * prompt's estimated tokens still fit inside the trailing-minute budget.
   * A 10k-token prompt against a 16k-TPM model therefore allows one call per
   * minute — the cascade falls through to a wider-TPM model for the next one.
   */
  canMakeRequestWithTokens(apiKey, model, estimatedTokens = 0, now = Date.now()) {
    const entry = this.entryFor(apiKey, model, now);
    const limits = this.effectiveLimits(model);
    if (entry.rpmTimestamps.length >= limits.rpm) return false;
    if (entry.rpdCount >= limits.rpd) return false;
    const spent = entry.tpmTokens.reduce((sum, row) => sum + row.tokens, 0);
    if (spent + estimatedTokens > limits.tpm) return false;
    return true;
  }

  recordRequest(apiKey, model, now = Date.now()) {
    this.recordRequestWithTokens(apiKey, model, 0, now);
  }

  recordRequestWithTokens(apiKey, model, estimatedTokens = 0, now = Date.now()) {
    const entry = this.entryFor(apiKey, model, now);
    entry.rpmTimestamps.push(now);
    entry.rpdCount += 1;
    if (estimatedTokens > 0) entry.tpmTokens.push({ tokens: estimatedTokens, timestamp: now });
  }

  /** Mark the daily quota spent — used when the API itself reports RESOURCE_EXHAUSTED. */
  markDailyExhausted(apiKey, model, now = Date.now()) {
    const entry = this.entryFor(apiKey, model, now);
    entry.rpdCount = Math.max(entry.rpdCount, this.effectiveLimits(model).rpd);
  }

  getUsage(apiKey, model, now = Date.now()) {
    const entry = this.entryFor(apiKey, model, now);
    const published = limitsForModel(model);
    return {
      rpm: { used: entry.rpmTimestamps.length, limit: published.rpm },
      rpd: { used: entry.rpdCount, limit: published.rpd },
      tpm: { used: this.tokensInWindow(apiKey, model, now), limit: published.tpm },
    };
  }

  /** Live snapshot for the admin dashboard. Never exposes key material. */
  exportState(keys = [], now = Date.now()) {
    return buildUsageSnapshot(this, keys, now);
  }

  /** Per-model totals across every key. Logged when a cascade runs dry. */
  getGlobalUsage(now = Date.now()) {
    const byModel = {};
    for (const [entryKey, entry] of this.usage) {
      const model = entryKey.slice(entryKey.indexOf('::') + 2);
      const published = limitsForModel(model);
      const live = entry.rpmTimestamps.filter((stamp) => now - stamp < RPM_WINDOW_MS).length;
      if (!byModel[model]) byModel[model] = { rpmUsed: 0, rpmLimit: 0, rpdUsed: 0, rpdLimit: 0, keys: 0 };
      byModel[model].rpmUsed += live;
      byModel[model].rpdUsed += entry.rpdCount;
      byModel[model].keys += 1;
      byModel[model].rpmLimit += published.rpm;
      byModel[model].rpdLimit += published.rpd;
    }
    return byModel;
  }

  /** One-line summary for logs, e.g. "gemma-4-31b rpd 120/14400 (2 keys)". */
  summarize(now = Date.now()) {
    const usage = this.getGlobalUsage(now);
    const parts = Object.entries(usage).map(([model, u]) =>
      `${model} rpm ${u.rpmUsed}/${u.rpmLimit} rpd ${u.rpdUsed}/${u.rpdLimit} (${u.keys} keys)`);
    return parts.length > 0 ? parts.join('; ') : 'no requests recorded';
  }
}

export default RateLimitTracker;
