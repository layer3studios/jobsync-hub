// FILE: src/services/admin/mission-control-service.js
// Totals, week-over-week movement and a live system strip for the admin home
// page. READ ONLY — every call here is a count, an aggregation or a ping.
//
// Nothing is re-derived: the scraper's last success comes from Feature 1's
// scrape_runs reads and the queue rollup from Feature 2's service, so the home
// page and the detail pages can never disagree.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { col, connectToDb } from '../../Db/connection.js';
import { findScrapeRuns } from '../../models/admin/scrape-run-model.js';
import { getQueueOverview } from './queue-monitor-service.js';
import { getAiUsageSnapshot } from '../../gemma/gemma-runtime.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STORAGE_DIR = path.resolve(BACKEND_ROOT, 'data');

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const SERIES_WEEKS = 8;

const NATIVE = 'native';
const SCRAPED = { sourceSite: { $exists: true } };

/** Counts in one window, so `thisWeek` and `prevWeek` can never drift apart. */
async function countBetween(collectionName, dateField, from, to) {
  const collection = await col(collectionName);
  return collection.countDocuments({ [dateField]: { $gte: from, $lt: to } });
}

/** { thisWeek, prevWeek, delta } for one collection's date field. */
async function weekOverWeek(collectionName, dateField, now) {
  const thisWeekStart = new Date(now.getTime() - WEEK_MS);
  const prevWeekStart = new Date(now.getTime() - 2 * WEEK_MS);
  const [thisWeek, prevWeek] = await Promise.all([
    countBetween(collectionName, dateField, thisWeekStart, now),
    countBetween(collectionName, dateField, prevWeekStart, thisWeekStart),
  ]);
  return { thisWeek, prevWeek, delta: thisWeek - prevWeek };
}

/** Application counts for the last 8 rolling 7-day windows, oldest first. */
async function applicationsByWeek(now) {
  const applications = await col('applications');
  const start = new Date(now.getTime() - SERIES_WEEKS * WEEK_MS);
  const docs = await applications
    .find({ appliedAt: { $gte: start, $lt: now } }, { projection: { appliedAt: 1 } })
    .toArray();

  const buckets = Array.from({ length: SERIES_WEEKS }, (_, index) => ({
    weekStart: new Date(start.getTime() + index * WEEK_MS),
    count: 0,
  }));
  for (const doc of docs) {
    const offset = Math.floor((doc.appliedAt.getTime() - start.getTime()) / WEEK_MS);
    if (offset >= 0 && offset < SERIES_WEEKS) buckets[offset].count += 1;
  }
  return buckets;
}

/** Platform totals plus week-over-week movement. */
export async function getOverview(now = new Date()) {
  const [users, employerUsers, companies, jobs, applications] = await Promise.all([
    col('users'), col('employer_users'), col('companies'), col('jobs'), col('applications'),
  ]);

  const [
    seekers, employers, companyCount, livePostings, scrapedJobs, applicationsTotal,
    newSeekers, newApplications, newPostings, weeklyApplications,
  ] = await Promise.all([
    users.countDocuments({}),
    employerUsers.countDocuments({}),
    companies.countDocuments({}),
    jobs.countDocuments({ source: NATIVE, status: 'active' }),
    jobs.countDocuments(SCRAPED),
    applications.countDocuments({}),
    weekOverWeek('users', 'createdAt', now),
    weekOverWeek('applications', 'appliedAt', now),
    weekOverWeek('jobs', 'createdAt', now),
    applicationsByWeek(now),
  ]);

  return {
    totals: { seekers, employers, companies: companyCount, livePostings, scrapedJobs, applicationsTotal },
    newSeekers,
    newApplications,
    newPostings,
    weeklyApplications,
  };
}

/**
 * Free bytes on the volume holding the upload/storage directory. statfs is not
 * available on every platform or filesystem; a failure returns null rather than
 * a wrong number, and the UI hides the tile.
 */
export async function getDiskFree(directory = STORAGE_DIR) {
  try {
    const stats = await fs.promises.statfs(directory);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

/** Cheap liveness ping. Never throws — a dead DB is a status, not a crash. */
async function pingDb() {
  try {
    const db = await connectToDb();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/** The live system strip. Every component degrades to null rather than throwing. */
export async function getSystemStatus() {
  const [dbOk, queues, diskFreeBytes] = await Promise.all([
    pingDb(),
    getQueueOverview().catch(() => []),
    getDiskFree(),
  ]);

  let scraperLastSuccessAt = null;
  try {
    // The newest successful row across every site — Feature 1's own read.
    const runs = await findScrapeRuns({ limit: 200 });
    scraperLastSuccessAt = runs.find((run) => run.scrapedSuccessfully)?.startedAt ?? null;
  } catch {
    scraperLastSuccessAt = null;
  }

  return {
    dbOk,
    scraperLastSuccessAt,
    queues: queues.map((queue) => ({
      key: queue.key,
      label: queue.label,
      failedCount: queue.failedCount,
      oldestPendingAgeMs: queue.oldestPendingAgeMs,
    })),
    ai: getAiUsageSnapshot() ?? { models: [] },
    diskFreeBytes,
  };
}

export default getOverview;
