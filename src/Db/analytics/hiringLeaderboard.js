// FILE: src/Db/analytics/hiringLeaderboard.js
// "Who's actually hiring right now" — public leaderboard. 1-hour cache.
// Pipeline + shaping helpers live in ./leaderboardShape.js to keep this small.

import { col } from '../connection.js';
import { buildPipeline, formatCompany } from './leaderboardShape.js';

const TTL_MS = 60 * 60 * 1000;
let cache = null;

function emptyResponse(now) {
  return {
    companies: [],
    totalNewThisWeek: 0,
    totalActiveRoles: 0,
    hiringFastCount: 0,
    staleCount: 0,
    summary: {},
    updatedAt: now.toISOString(),
  };
}

export async function getHiringLeaderboard() {
  if (cache && (Date.now() - cache.timestamp) < TTL_MS) return cache.data;

  const jobs = await col('jobs');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  try {
    const raw = await jobs
      .aggregate(buildPipeline(now, sevenDaysAgo, fourteenDaysAgo, thirtyDaysAgo))
      .toArray();
    const companies = raw.map(formatCompany);

    const totalNewThisWeek = companies.reduce((s, c) => s + c.newThisWeek, 0);
    const totalNewLastWeek = companies.reduce((s, c) => s + c.newLastWeek, 0);
    const totalActiveJobs = companies.reduce((s, c) => s + c.totalActiveRoles, 0);
    const hotCompanies = companies.filter(c => c.hiringSignal === 'hot').length;
    const staleCompanies = companies.filter(c => c.hiringSignal === 'stale').length;

    const data = {
      companies,
      // Flat fields the frontend reads directly
      totalNewThisWeek,
      totalActiveRoles: totalActiveJobs,
      hiringFastCount: hotCompanies,
      staleCount: staleCompanies,
      // Nested summary for back-compat
      summary: {
        totalCompanies: companies.length,
        totalActiveJobs,
        totalNewThisWeek,
        totalNewLastWeek,
        weekOverWeekDelta: totalNewThisWeek - totalNewLastWeek,
        hotCompanies,
        staleCompanies,
      },
      updatedAt: now.toISOString(),
    };
    cache = { data, timestamp: Date.now() };
    return data;
  } catch (err) {
    console.error('[getHiringLeaderboard]', err);
    if (cache) return cache.data;
    return emptyResponse(now);
  }
}
