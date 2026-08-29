// FILE: src/services/admin/analytics-retention-queries.js
// Retention + stickiness HogQL builders, split out of analytics-queries.js to keep
// that file under the size cap. Same conventions: validated ISO `since` inlined into
// toDateTime(...), read-only, and NO JOINs.
//
// TWO DELIBERATE DEPARTURES, both visible in the shaped response:
//
// 1. STICKINESS WINDOWS ARE FIXED, not driven by the range selector. DAU/WAU/MAU mean
//    1/7/30 days by definition; honouring a '24h' range would make MAU a 24-hour
//    number still labelled "monthly". The builders take `since` for signature
//    compatibility and cache-key purposes but bound their own windows.
//
// 2. W1 COHORT RETENTION IS APPROXIMATE. Exact W1 ("returned 7–14 days after signing
//    up") requires correlating each person's signup timestamp against their later
//    events — a self-join, which this layer does not do. What is computable in one
//    nested aggregate over a single table is each person's FIRST and LAST event, so
//    the metric shipped is "still active 7+ days after first seen", grouped by the
//    week they were first seen. Numerator and denominator come from the same
//    population, so the percentage is internally consistent; it is NOT the textbook
//    W1 figure, and every field name and the UI say so.

const at = (s) => `toDateTime('${s}')`;

/**
 * DAU / WAU / MAU in one row, as three uniqIf aggregates over a 30-day window.
 * uniq(person_id) rather than count(DISTINCT ...) so the conditional variants are
 * available; anonymous events share no person_id, so these count identified people.
 */
export const stickiness = () =>
  'SELECT '
  + 'uniqIf(person_id, timestamp >= now() - toIntervalDay(1)) AS dau, '
  + 'uniqIf(person_id, timestamp >= now() - toIntervalDay(7)) AS wau, '
  + 'uniq(person_id) AS mau '
  + 'FROM events WHERE timestamp >= now() - toIntervalDay(30)';

/**
 * Per-week cohorts over the last 6 ISO weeks. The inner aggregate collapses the
 * events table to one row per person (first_ts, last_ts); the outer groups those
 * people by the week they were first seen. No JOIN — a derived table over the same
 * single `events` source.
 *
 * `approx_w1` counts people whose LAST activity is at least 7 days after their FIRST.
 * A person active only on days 0–3 does not count; a person active on day 20 does,
 * even though a strict 7–14 day window would exclude them. That is the approximation.
 */
export const weeklyCohorts = () =>
  'SELECT toStartOfWeek(first_ts) AS cohort_week, '
  + 'uniq(person_id) AS cohort_size, '
  + 'countIf(last_ts >= first_ts + toIntervalDay(7)) AS approx_w1 '
  + 'FROM ('
  + 'SELECT person_id, min(timestamp) AS first_ts, max(timestamp) AS last_ts '
  + 'FROM events WHERE timestamp >= now() - toIntervalWeek(6) '
  + 'GROUP BY person_id'
  + ') GROUP BY cohort_week ORDER BY cohort_week';

/**
 * Seeker signups per ISO week, for context beside the cohort table. This is a
 * DIFFERENT population from cohort_size (which counts everyone first seen that week,
 * signed up or not), so the two are shown side by side and never divided.
 */
export const signupsByWeek = (s) =>
  "SELECT toStartOfWeek(timestamp) AS week, count(DISTINCT person_id) AS value "
  + `FROM events WHERE event = 'seeker_signup_completed' AND timestamp >= ${at(s)} `
  + 'GROUP BY week ORDER BY week';

/** Percentage to one decimal; a zero denominator is 0, never NaN or Infinity. */
export const pct = (numerator, denominator) =>
  (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0);

/** Cohorts below this many people are too small for their % to mean anything. */
export const LOW_SAMPLE_THRESHOLD = 20;

/**
 * One row per ISO week. `approxW1Returns` is "still active 7+ days after first seen",
 * NOT textbook W1 retention (see the header). The field name and the response's
 * `isApproximate` flag carry that so no caller can mistake it for exact.
 */
export const cohortRows = (rows, signupRows) => {
  // Named to avoid shadowing the signupsByWeek query builder above.
  const signupsPerWeek = new Map(
    (signupRows ?? []).map(([week, value]) => [String(week), Number(value)]),
  );
  return (rows ?? []).map(([week, size, returns]) => {
    const cohortSize = Number(size ?? 0);
    const approxW1Returns = Number(returns ?? 0);
    return {
      week: String(week),
      cohortSize,
      approxW1Returns,
      approxW1Pct: pct(approxW1Returns, cohortSize),
      // A different population from cohortSize — shown alongside, never divided into it.
      signups: signupsPerWeek.get(String(week)) ?? 0,
      isLowSample: cohortSize < LOW_SAMPLE_THRESHOLD,
    };
  });
};

/** name → (since) => HogQL. Merged into QUERIES by analytics-queries.js. */
export const RETENTION_QUERIES = {
  dau_mau: stickiness,
  weekly_cohort_returns: weeklyCohorts,
  retention_signups_by_week: signupsByWeek,
};

export default RETENTION_QUERIES;
