// FILE: src/services/admin/ai-usage-service.js
// Folds raw ai_usage_stats documents into the admin dashboard shape. Pure
// aggregation over an already-fetched array — no DB access here, so it is
// trivially testable and the route stays thin.

const TIERS = ['employer', 'seeker', 'scraper'];

const sumErrors = (errors) => Object.values(errors ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
const percent = (numerator, denominator) =>
  (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0);

/** Blank accumulator so every tier appears even with no traffic. */
function emptyTierMap() {
  return Object.fromEntries(TIERS.map((tier) => [tier, { requests: 0, tokens: 0, errors: 0 }]));
}

function accumulate(target, doc) {
  target.requests += doc.requests ?? 0;
  target.tokens += doc.tokensEstimated ?? 0;
  target.errors += sumErrors(doc.errors);
  if ('cacheHits' in target) target.cacheHits += doc.cacheHits ?? 0;
}

/**
 * @param {object[]} docs raw ai_usage_stats rows
 * @param {object} currentLimits live snapshot from the RateLimitTracker
 */
export function buildUsageReport(docs = [], currentLimits = { models: [] }) {
  const byTier = emptyTierMap();
  const byModelMap = new Map();
  const byDayMap = new Map();
  let totalRequests = 0;
  let totalTokens = 0;
  let totalCacheHits = 0;
  let totalErrors = 0;

  for (const doc of docs) {
    const requests = doc.requests ?? 0;
    const tokens = doc.tokensEstimated ?? 0;
    const cacheHits = doc.cacheHits ?? 0;
    const errors = sumErrors(doc.errors);

    totalRequests += requests;
    totalTokens += tokens;
    totalCacheHits += cacheHits;
    totalErrors += errors;

    // An unrecognised tier is still counted rather than silently dropped.
    if (!byTier[doc.tier]) byTier[doc.tier] = { requests: 0, tokens: 0, errors: 0 };
    accumulate(byTier[doc.tier], doc);

    if (!byModelMap.has(doc.model)) {
      byModelMap.set(doc.model, { model: doc.model, requests: 0, tokens: 0, cacheHits: 0, errors: 0 });
    }
    accumulate(byModelMap.get(doc.model), doc);

    if (!byDayMap.has(doc.date)) {
      byDayMap.set(doc.date, { date: doc.date, requests: 0, tokens: 0, cacheHits: 0, errors: 0 });
    }
    accumulate(byDayMap.get(doc.date), doc);
  }

  const byModel = [...byModelMap.values()]
    .map((row) => ({
      ...row,
      avgTokensPerRequest: row.requests > 0 ? Math.round(row.tokens / row.requests) : 0,
    }))
    .sort((a, b) => b.requests - a.requests);

  const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary: {
      totalRequests,
      totalTokens,
      totalCacheHits,
      // Share of answered calls that never reached the API.
      cacheHitRate: percent(totalCacheHits, totalCacheHits + totalRequests),
      totalErrors,
      errorRate: percent(totalErrors, totalRequests),
    },
    byTier,
    byModel,
    byDay,
    currentLimits,
  };
}

export default buildUsageReport;
