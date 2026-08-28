// FILE: src/services/admin/company-health-service.js
// One row per company for the admin Company Health table. READ ONLY.
//
// Native postings and scraped jobs share the `jobs` collection and are told
// apart by `source: 'native'` (posting-model) vs `sourceSite` (job-model) —
// the same distinction scraper-health-service draws from the other side.
//
// This is an internal page over a handful of companies, so it favours one
// readable aggregation over several hand-tuned round trips.

import { col } from '../../Db/connection.js';

const NATIVE = 'native';
const ACTIVE_POSTING_STATUS = 'active';
const DAY_MS = 86_400_000;

/** Inactivity thresholds, in days, measured against lastActivityAt. */
export const QUIET_AFTER_DAYS = 14;
export const DORMANT_AFTER_DAYS = 45;

/**
 * A company is only as active as the freshest of: a posting created or edited,
 * and an application received. A member merely logging in is NOT activity — an
 * idle tab reopening would otherwise mask a company that has stopped hiring.
 * lastMemberLoginAt is reported separately so that signal stays visible.
 */
export function statusFor(lastActivityAt, now = new Date()) {
  if (!lastActivityAt) return 'dormant';
  const ageDays = (now.getTime() - new Date(lastActivityAt).getTime()) / DAY_MS;
  if (ageDays <= QUIET_AFTER_DAYS) return 'active';
  if (ageDays <= DORMANT_AFTER_DAYS) return 'quiet';
  return 'dormant';
}

/** The newest of a set of dates, ignoring nulls. Returns null when all are null. */
function latest(...dates) {
  const times = dates
    .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()))
    .map((date) => date.getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

/** One row per company, worst-first ordering left to the client. */
export async function listCompanyHealth(now = new Date()) {
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  const companies = await col('companies');

  const rows = await companies.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: 'company_members',
        localField: '_id',
        foreignField: 'companyId',
        as: 'members',
      },
    },
    {
      // Native postings only: a scraped job carries no companyId, but matching
      // on source keeps the intent explicit rather than relying on that.
      $lookup: {
        from: 'jobs',
        let: { companyId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$companyId', '$$companyId'] }, source: NATIVE } },
          { $project: { status: 1, updatedAt: 1, createdAt: 1 } },
        ],
        as: 'postings',
      },
    },
    {
      $lookup: {
        from: 'applications',
        let: { companyId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$companyId', '$$companyId'] } } },
          { $project: { appliedAt: 1 } },
        ],
        as: 'applications',
      },
    },
    {
      // employer_users holds the login timestamps; company_members is the join.
      $lookup: {
        from: 'employer_users',
        localField: 'members.employerUserId',
        foreignField: '_id',
        as: 'memberUsers',
      },
    },
    {
      $project: {
        name: 1,
        slug: 1,
        createdAt: 1,
        memberCount: { $size: '$members' },
        livePostingCount: {
          $size: {
            $filter: {
              input: '$postings',
              as: 'posting',
              cond: { $eq: ['$$posting.status', ACTIVE_POSTING_STATUS] },
            },
          },
        },
        totalApplicants: { $size: '$applications' },
        applicantsLast30d: {
          $size: {
            $filter: {
              input: '$applications',
              as: 'application',
              cond: { $gte: ['$$application.appliedAt', since30d] },
            },
          },
        },
        lastMemberLoginAt: { $max: '$memberUsers.lastLoginAt' },
        lastPostingAt: {
          $max: { $map: { input: '$postings', as: 'p', in: { $ifNull: ['$$p.updatedAt', '$$p.createdAt'] } } },
        },
        lastApplicationAt: { $max: '$applications.appliedAt' },
      },
    },
  ]).toArray();

  return rows.map((row) => {
    const lastActivityAt = latest(row.lastPostingAt, row.lastApplicationAt);
    return {
      companyId: row._id.toString(),
      name: row.name ?? null,
      slug: row.slug ?? null,
      createdAt: row.createdAt ?? null,
      memberCount: row.memberCount ?? 0,
      livePostingCount: row.livePostingCount ?? 0,
      totalApplicants: row.totalApplicants ?? 0,
      applicantsLast30d: row.applicantsLast30d ?? 0,
      lastMemberLoginAt: row.lastMemberLoginAt ?? null,
      lastPostingAt: row.lastPostingAt ?? null,
      lastApplicationAt: row.lastApplicationAt ?? null,
      lastActivityAt,
      status: statusFor(lastActivityAt, now),
    };
  });
}

export default listCompanyHealth;
