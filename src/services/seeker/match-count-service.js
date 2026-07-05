// FILE: src/services/seeker/match-count-service.js
// getMatchCountForUser(userId, filters) — how many current postings in the
// unified `jobs` pool match this seeker right now (D3). userId-scoped (C8):
// profile is loaded via getProfileForUser and the cache key embeds the userId.
// The DB guard is a coarse active+recent+parsedRequirements filter; the exact
// skill/experience predicate runs in JS (matchesJobForProfile) so the alias
// table and the pure helper stay reusable in tests (R2). Volume is MVP-scale
// (Watch: revisit if the active pool grows past ~10k).

import { col } from '../../Db/connection.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getProfileForUser } from '../../models/seeker/seeker-profile-helpers.js';
import { marketCache } from './market-cache.js';
import {
  buildBaseJobMatch, matchesJobForProfile,
  resolveJobLocation, resolveRoleCategory,
} from './profile-match-helpers.js';

const TOP_N = 5;

function locationMatches(job, location) {
  const jobLocation = resolveJobLocation(job);
  if (!jobLocation) return false;
  return jobLocation.toLowerCase().includes(String(location).toLowerCase().trim());
}

function topCounts(items, keyFn) {
  const tally = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([key, count]) => ({ key, count }));
}

function buildBreakdown(jobs) {
  return {
    byLocation: topCounts(jobs, resolveJobLocation),
    byRoleCategory: topCounts(jobs, resolveRoleCategory),
  };
}

/** Live match count for a seeker, with optional post-match location filter. */
export async function getMatchCountForUser(userId, filters = {}) {
  const profile = await getProfileForUser(userId);
  if (!profile) throw new HttpError(400, 'No parsed profile found.', 'NO_PROFILE');

  const location = filters.location ?? null;
  const cacheKey = `match:${userId}:${location ?? ''}`;
  const cached = marketCache.get(cacheKey);
  if (cached) return cached;

  const now = Date.now();
  const jobs = await col('jobs');
  const docs = await jobs.aggregate([{ $match: buildBaseJobMatch(now) }]).toArray();

  const matched = docs.filter((job) => matchesJobForProfile(job, profile, now));
  const scoped = location ? matched.filter((job) => locationMatches(job, location)) : matched;

  const result = {
    count: scoped.length,
    breakdown: buildBreakdown(scoped),
    asOf: new Date(now).toISOString(),
  };
  marketCache.set(cacheKey, result);
  return result;
}

export default getMatchCountForUser;
