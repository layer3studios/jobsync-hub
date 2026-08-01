// FILE: src/gemma/usage-stats.js
// Persistent daily AI usage, one document per (date, tier, model, keyIndex).
// The in-memory RateLimitTracker answers "what can I spend right now"; this
// answers "what did we spend" and survives restarts.
//
// FIRE-AND-FORGET: every writer swallows its own errors. A stats write must
// never fail or delay an AI call — losing a counter is strictly better than
// losing the request it describes.
//
// KEY SECRECY: only the key's INDEX is stored, never the key.

import { col } from '../Db/connection.js';

const COLLECTION = 'ai_usage_stats';
const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export const ERROR_BUCKETS = Object.freeze({
  RATE_LIMITED: 'rate_limited',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  SERVER_ERROR: 'server_error',
  OTHER: 'other',
});

const statsCol = () => col(COLLECTION);

/** IST calendar date (YYYY-MM-DD) — the business day these stats belong to. */
export function istDateString(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Idempotent index setup. The TTL rides a real Date field (dateExpiry) because
 * Mongo cannot expire on the string `date` we group by.
 */
export async function ensureUsageStatsIndexes() {
  const collection = await statsCol();
  await collection.createIndex(
    { date: 1, tier: 1, model: 1, apiKeyIndex: 1 },
    { unique: true, name: 'ai_usage_date_tier_model_key' },
  );
  await collection.createIndex(
    { dateExpiry: 1 },
    { expireAfterSeconds: 0, name: 'ai_usage_ttl' },
  );
}

/** The moment this day's document becomes eligible for TTL removal. */
function expiryFor(dateString) {
  return new Date(new Date(`${dateString}T00:00:00.000Z`).getTime() + RETENTION_DAYS * MS_PER_DAY);
}

/** Shared upsert. `inc` is the $inc document; the identity fields are the key. */
async function bump({ tier, model, apiKeyIndex = 0, now = new Date() }, inc) {
  try {
    const date = istDateString(now);
    const collection = await statsCol();
    await collection.updateOne(
      { date, tier, model, apiKeyIndex },
      {
        $inc: inc,
        $set: { updatedAt: now, dateExpiry: expiryFor(date) },
        $setOnInsert: { date, tier, model, apiKeyIndex },
      },
      { upsert: true },
    );
  } catch (err) {
    // Never propagate: this is telemetry, not the payload.
    console.warn(`[ai-usage] stats write failed: ${err.message}`);
  }
}

/** A completed API call: one request plus its estimated token spend. */
export function recordUsageRequest(identity, estimatedTokens = 0) {
  return bump(identity, { requests: 1, tokensEstimated: estimatedTokens });
}

/** A response served from the cache — no request, no tokens. */
export function recordUsageCacheHit(identity) {
  return bump(identity, { cacheHits: 1 });
}

/** A failed call, bucketed by cause. Unknown causes land in `other`. */
export function recordUsageError(identity, bucket = ERROR_BUCKETS.OTHER) {
  const safeBucket = Object.values(ERROR_BUCKETS).includes(bucket) ? bucket : ERROR_BUCKETS.OTHER;
  return bump(identity, { [`errors.${safeBucket}`]: 1 });
}

/** Every stats document from the last `days` IST days, oldest first. */
export async function listUsageStats(days = 7, now = new Date()) {
  const since = istDateString(new Date(now.getTime() - (days - 1) * MS_PER_DAY));
  const collection = await statsCol();
  return collection.find({ date: { $gte: since } }).sort({ date: 1 }).toArray();
}

export default recordUsageRequest;
