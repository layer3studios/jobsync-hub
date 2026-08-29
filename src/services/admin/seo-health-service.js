// FILE: src/services/admin/seo-health-service.js
// Reads for the admin SEO panel. READ ONLY apart from the queue writes the route
// delegates to the job model.
//
// "Missing" mirrors what the frontend's JobPosting JSON-LD actually emits
// (src/lib/schema/job-posting.ts): employmentType falls back to 'FULL_TIME' and
// location to 'India' when absent, and baseSalary is omitted entirely without a
// salary. Those fallbacks keep the markup valid but make the listing generic, so
// they are exactly what this panel counts.

import { col } from '../../Db/connection.js';
import {
  countIndexingByStatus, countSubmissionsToday, listRecentFailures,
  findDeletedPostingIds, DAILY_QUOTA,
} from '../../models/admin/indexing-job-model.js';

const NATIVE = 'native';
const LIVE = 'active';
const DAY_MS = 86_400_000;
const STALE_WINDOW_DAYS = 30;

const LIVE_NATIVE = { source: NATIVE, status: LIVE };

/** Live native postings, and how many lack each field the JSON-LD wants. */
export async function getSchemaHealth() {
  const jobs = await col('jobs');
  const [row] = await jobs.aggregate([
    { $match: LIVE_NATIVE },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        missingSalary: {
          $sum: {
            $cond: [{
              $and: [
                { $in: [{ $ifNull: ['$salaryMin', null] }, [null, 0]] },
                { $in: [{ $ifNull: ['$salaryMax', null] }, [null, 0]] },
              ],
            }, 1, 0],
          },
        },
        missingLocation: {
          $sum: { $cond: [{ $eq: [{ $strLenCP: { $ifNull: ['$location', ''] } }, 0] }, 1, 0] },
        },
        missingEmploymentType: {
          $sum: { $cond: [{ $eq: [{ $strLenCP: { $ifNull: ['$employmentType', ''] } }, 0] }, 1, 0] },
        },
      },
    },
  ]).toArray();

  return {
    total: row?.total ?? 0,
    missingSalary: row?.missingSalary ?? 0,
    missingLocation: row?.missingLocation ?? 0,
    missingEmploymentType: row?.missingEmploymentType ?? 0,
  };
}

/** Queue depth, today's quota spend, and the most recent terminal failures. */
export async function getIndexingStats(now = new Date()) {
  const [counts, submittedToday, failures] = await Promise.all([
    countIndexingByStatus(),
    countSubmissionsToday(now),
    listRecentFailures(10),
  ]);

  return {
    counts,
    submittedToday,
    dailyQuota: DAILY_QUOTA,
    quotaRemaining: Math.max(0, DAILY_QUOTA - submittedToday),
    recentFailures: failures.map((job) => ({
      id: job._id.toString(),
      postingId: job.postingId?.toString() ?? null,
      url: job.url ?? null,
      action: job.action,
      attemptCount: job.attemptCount ?? 0,
      lastError: job.lastError ?? null,
      completedAt: job.completedAt ?? null,
    })),
  };
}

/**
 * Postings that left the public site in the last 30 days without a completed
 * URL_DELETED — the "Google was never told" list. A stale URL keeps drawing
 * candidates to a job nobody can apply for, which is worse than not ranking.
 */
export async function getStaleUrls(now = new Date()) {
  const jobs = await col('jobs');
  const since = new Date(now.getTime() - STALE_WINDOW_DAYS * DAY_MS);

  const closed = await jobs.find(
    {
      source: NATIVE,
      status: { $ne: LIVE },
      // closedAt is stamped on close/fill; updatedAt covers the rest.
      $or: [{ closedAt: { $gte: since } }, { closedAt: null, updatedAt: { $gte: since } }],
    },
    { projection: { title: 1, slug: 1, status: 1, closedAt: 1, updatedAt: 1, companyId: 1 } },
  ).sort({ closedAt: -1, updatedAt: -1 }).limit(100).toArray();

  const alreadyTold = await findDeletedPostingIds(closed.map((posting) => posting._id));

  return closed
    .filter((posting) => !alreadyTold.has(posting._id.toString()))
    .map((posting) => ({
      postingId: posting._id.toString(),
      title: posting.title ?? null,
      slug: posting.slug ?? null,
      status: posting.status ?? null,
      closedAt: posting.closedAt ?? posting.updatedAt ?? null,
    }));
}

/** One live native posting, for the manual submit route. Null when not eligible. */
export async function findLiveNativePosting(postingId) {
  const jobs = await col('jobs');
  const { ObjectId } = await import('mongodb');
  if (!ObjectId.isValid(postingId)) return null;
  return jobs.findOne({ _id: new ObjectId(postingId), source: NATIVE });
}

export default getSchemaHealth;
