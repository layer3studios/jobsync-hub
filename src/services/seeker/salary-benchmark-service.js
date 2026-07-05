// FILE: src/services/seeker/salary-benchmark-service.js
// getSalaryBenchmarkForUser(userId) — P25/P50/P75 salary band over the matching
// slice of the `jobs` pool (D4). Percentiles, not averages, because outliers
// skew means (R1). Below MIN_SAMPLE_SIZE the percentiles are null and only
// sampleSize is reported so the frontend can show "not enough data" (R1).
// userId-scoped (C8): profile loaded via getProfileForUser, cache key embeds it.

import { col } from '../../Db/connection.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getProfileForUser } from '../../models/seeker/seeker-profile-helpers.js';
import { marketCache } from './market-cache.js';
import { buildBaseJobMatch } from './profile-match-helpers.js';

export const MIN_SAMPLE_SIZE = 10;
const CURRENCY = 'INR';
const UNIT = 'LPA';

// Midpoint of an inferred salary range: both bounds → mean, else the present
// bound, else null (skip).
function salaryMidpoint(range) {
  if (!range || typeof range !== 'object') return null;
  const min = typeof range.min === 'number' ? range.min : null;
  const max = typeof range.max === 'number' ? range.max : null;
  if (min !== null && max !== null) return (min + max) / 2;
  if (min !== null) return min;
  if (max !== null) return max;
  return null;
}

// Linear-interpolation percentile over an ascending array. Rounded to 0.5 LPA.
function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const rank = fraction * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value = sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
  return Math.round(value * 2) / 2;
}

/** Salary benchmark for a seeker, scoped to their seniority when known. */
export async function getSalaryBenchmarkForUser(userId) {
  const profile = await getProfileForUser(userId);
  if (!profile) throw new HttpError(400, 'No parsed profile found.', 'NO_PROFILE');

  const seniority = profile.seniorityLevel ?? null;
  const filters = { seniority, roleCategory: null, location: null };
  const cacheKey = `salary:${userId}`;
  const cached = marketCache.get(cacheKey);
  if (cached) return cached;

  const now = Date.now();
  const match = buildBaseJobMatch(now);
  match['parsedRequirements.salary_range_inferred'] = { $exists: true, $ne: null };
  if (seniority) match['parsedRequirements.experience_level'] = seniority;

  const jobs = await col('jobs');
  const docs = await jobs.aggregate([{ $match: match }]).toArray();

  const midpoints = [];
  for (const job of docs) {
    const midpoint = salaryMidpoint(job.parsedRequirements?.salary_range_inferred);
    if (midpoint !== null) midpoints.push(midpoint);
  }
  const sampleSize = midpoints.length;

  let p25 = null;
  let p50 = null;
  let p75 = null;
  if (sampleSize >= MIN_SAMPLE_SIZE) {
    midpoints.sort((a, b) => a - b);
    p25 = percentile(midpoints, 0.25);
    p50 = percentile(midpoints, 0.5);
    p75 = percentile(midpoints, 0.75);
  }

  const result = {
    p25, p50, p75, sampleSize,
    currency: CURRENCY, unit: UNIT, filters,
    asOf: new Date(now).toISOString(),
  };
  marketCache.set(cacheKey, result);
  return result;
}

export default getSalaryBenchmarkForUser;
