// FILE: src/Db/analytics/marketPulse.js
// Role-category demand snapshot. 6-hour in-memory cache.

import { col } from '../connection.js';

const TTL_MS = 6 * 60 * 60 * 1000;
let cache = null;

function buildEmptyResponse(now) {
  return { categories: [], totalJobs: 0, updatedAt: now.toISOString() };
}

export async function getMarketPulse() {
  if (cache && (Date.now() - cache.timestamp) < TTL_MS) return cache.data;

  const jobs = await col('jobs');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

  const baseMatch = {
    Status: 'active',
    'autoTags.roleCategory': { $exists: true, $ne: null, $type: 'string' },
  };

  let current, thisWeek, lastWeek;
  try {
    [current, thisWeek, lastWeek] = await Promise.all([
      jobs.aggregate([
        { $match: baseMatch },
        { $group: { _id: '$autoTags.roleCategory', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      jobs.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: '$autoTags.roleCategory', count: { $sum: 1 } } },
      ]).toArray(),
      jobs.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: fourteenDaysAgo, $lte: sevenDaysAgo } } },
        { $group: { _id: '$autoTags.roleCategory', count: { $sum: 1 } } },
      ]).toArray(),
    ]);
  } catch (err) {
    console.error('[getMarketPulse] aggregation failed:', err);
    if (cache) return cache.data;
    return buildEmptyResponse(now);
  }

  const thisWeekMap = new Map(thisWeek.map(r => [r._id, r.count]));
  const lastWeekMap = new Map(lastWeek.map(r => [r._id, r.count]));

  const categories = current
    .filter(c => c._id && typeof c._id === 'string')
    .map(c => {
      const tw = thisWeekMap.get(c._id) || 0;
      const lw = lastWeekMap.get(c._id) || 0;
      let trendPercent = lw > 0 ? Math.round(((tw - lw) / lw) * 100) : (tw > 0 ? 100 : 0);
      trendPercent = Math.max(-200, Math.min(200, trendPercent));
      const trend = trendPercent > 5 ? 'up' : trendPercent < -5 ? 'down' : 'stable';
      return { category: c._id, totalRoles: c.count, newThisWeek: tw, trendPercent, trend };
    });

  const totalJobs = categories.reduce((sum, c) => sum + c.totalRoles, 0);
  const data = { categories, totalJobs, updatedAt: now.toISOString() };
  cache = { data, timestamp: Date.now() };
  return data;
}
