// FILE: src/Db/companies/intel.js
// Per-company hiring intelligence. 1-hour in-memory cache.

import { col } from '../connection.js';

const cache = new Map();
const TTL_MS = 60 * 60 * 1000;

const EMPTY = {
  companyName: '', totalOpenRoles: 0, newRolesThisWeek: 0, newRolesLastWeek: 0,
  avgRoleAgeDays: 0, oldestRoleDays: 0, newestRoleDays: 0, hiringTrend: 'stable',
  peakPostingDay: null, busiestDays: [], postingDayDistribution: [0, 0, 0, 0, 0, 0, 0],
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function getCompanyIntel(companyName) {
  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    return EMPTY;
  }
  const key = companyName.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.timestamp) < TTL_MS) return hit.data;

  const jobs = await col('jobs');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

  const escaped = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await jobs.find(
    { Company: { $regex: new RegExp(`^${escaped}$`, 'i') }, Status: 'active' },
    { projection: { PostedDate: 1, createdAt: 1, scrapedAt: 1 } },
  ).toArray();

  const totalOpenRoles = docs.length;
  const newRolesThisWeek = docs.filter(d => new Date(d.createdAt || d.scrapedAt) >= sevenDaysAgo).length;
  const newRolesLastWeek = docs.filter(d => {
    const ts = new Date(d.createdAt || d.scrapedAt);
    return ts >= fourteenDaysAgo && ts < sevenDaysAgo;
  }).length;

  const ages = docs
    .map(d => Math.floor((now - new Date(d.PostedDate || d.createdAt || d.scrapedAt)) / 86400000))
    .filter(a => Number.isFinite(a) && a >= 0);

  const avgRoleAgeDays = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
  const oldestRoleDays = ages.length > 0 ? Math.max(...ages) : 0;
  const newestRoleDays = ages.length > 0 ? Math.min(...ages) : 0;

  let hiringTrend = 'stable';
  if (newRolesThisWeek > newRolesLastWeek) hiringTrend = 'up';
  else if (newRolesThisWeek < newRolesLastWeek) hiringTrend = 'down';

  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of docs) {
    const ts = new Date(d.PostedDate || d.createdAt || d.scrapedAt);
    if (!Number.isNaN(ts.getTime())) dayCounts[ts.getDay()]++;
  }
  const dayPairs = dayCounts.map((count, i) => ({ day: DAY_NAMES[i], count }));
  dayPairs.sort((a, b) => b.count - a.count);
  const busiestDays = dayPairs.filter(d => d.count > 0).slice(0, 3).map(d => d.day);

  const data = {
    companyName: companyName.trim(), totalOpenRoles, newRolesThisWeek, newRolesLastWeek,
    avgRoleAgeDays, oldestRoleDays, newestRoleDays, hiringTrend,
    peakPostingDay: busiestDays[0] || null, busiestDays,
    postingDayDistribution: dayCounts,
  };
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}
