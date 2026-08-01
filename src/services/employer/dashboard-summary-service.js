// FILE: src/services/employer/dashboard-summary-service.js
// One-call dashboard summary: KPI tiles + active jobs + top candidates.
// Every query puts companyId FIRST in the filter — the tenant boundary and the
// index prefix (§6.5). Filter early, reshape early, join late: the only
// $lookup (resume_scores) runs after the companyId+jobId $match, and the
// $group is bounded by (active jobs × stages).
//
// SCALE ESCAPE HATCH: at 1000+ applicants the per-stage aggregation becomes
// the bottleneck. If that day comes, pre-aggregate a posting-level summary on
// each stage move instead of computing it per request. Not done now — a
// startup with <100 applicants runs this in tens of milliseconds.

import { col } from '../../Db/connection.js';
import {
  toOid, NATIVE_SOURCE, mapContactsById, mapStageNamesById, listHiredStageIds,
} from './dashboard-helpers.js';
import { buildNeedsAttention } from './dashboard-attention-service.js';

const STRONG_SCORE_FLOOR = 80;

const TOP_CANDIDATE_LIMIT = 5;
const MS_PER_DAY = 86400000;

// Response keys for the canonical default pipeline; unknown stages are ignored.
const STAGE_KEYS = ['applied', 'shortlisted', 'interview', 'offer', 'hired'];

/** Monday 00:00:00.000 UTC → Sunday 23:59:59.999 UTC of the current week. */
export function utcWeekRange(now = new Date()) {
  const mondayOffset = (now.getUTCDay() + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));
  const weekEnd = new Date(weekStart.getTime() + 7 * MS_PER_DAY - 1);
  return { weekStart, weekEnd };
}

const emptyStageCounts = () => Object.fromEntries(STAGE_KEYS.map((key) => [key, 0]));
const daysBetween = (from, to) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));

/** Per-(job, stage) applicant counts + score sums for the active postings. */
async function aggregateApplicantStats(companyOid, postingIds) {
  if (postingIds.length === 0) return [];
  const collection = await col('applications');
  return collection.aggregate([
    { $match: { companyId: companyOid, jobId: { $in: postingIds } } },
    { $lookup: { from: 'resume_scores', localField: '_id', foreignField: 'applicationId', as: 'scoreDoc' } },
    { $addFields: { score: { $first: '$scoreDoc.score' } } },
    { $group: {
      _id: { jobId: '$jobId', stageId: '$stageId' },
      count: { $sum: 1 },
      scoreSum: { $sum: { $cond: [{ $isNumber: '$score' }, '$score', 0] } },
      scoredCount: { $sum: { $cond: [{ $isNumber: '$score' }, 1, 0] } },
      strongCount: { $sum: { $cond: [{ $and: [{ $isNumber: '$score' }, { $gte: ['$score', STRONG_SCORE_FLOOR] }] }, 1, 0] } },
    } },
  ]).toArray();
}

async function countInterviewsThisWeek(companyOid, now) {
  const { weekStart, weekEnd } = utcWeekRange(now);
  const collection = await col('interviews');
  return collection.countDocuments({
    companyId: companyOid, status: 'scheduled', startAtUtc: { $gte: weekStart, $lte: weekEnd },
  });
}

async function countNewApplicationsThisWeek(companyOid, now) {
  const { weekStart } = utcWeekRange(now);
  const collection = await col('applications');
  return collection.countDocuments({ companyId: companyOid, createdAt: { $gte: weekStart } });
}

/** Average (hire timestamp − appliedAt) in days; null when nobody is hired. */
async function averageDaysToHire(companyOid, hiredStageIds) {
  if (hiredStageIds.length === 0) return null;
  const collection = await col('applications');
  const hired = await collection
    .find({ companyId: companyOid, stageId: { $in: hiredStageIds } })
    .project({ appliedAt: 1, lastStageMovedAt: 1, updatedAt: 1 })
    .toArray();
  if (hired.length === 0) return null;
  const totalDays = hired.reduce((sum, doc) => {
    const hiredAt = doc.lastStageMovedAt ?? doc.updatedAt ?? doc.appliedAt;
    return sum + daysBetween(doc.appliedAt, hiredAt);
  }, 0);
  return Math.round((totalDays / hired.length) * 10) / 10;
}

/** Top 5 by AI score across active postings. No internal ids in the output. */
async function loadTopCandidates(companyOid, postingIds, postingTitleById, stageNameById) {
  if (postingIds.length === 0) return [];
  const collection = await col('applications');
  const rows = await collection.aggregate([
    { $match: { companyId: companyOid, jobId: { $in: postingIds }, archived: null } },
    { $lookup: { from: 'resume_scores', localField: '_id', foreignField: 'applicationId', as: 'scoreDoc' } },
    { $addFields: { score: { $first: '$scoreDoc.score' } } },
    { $sort: { score: -1, appliedAt: -1 } },
    { $limit: TOP_CANDIDATE_LIMIT },
    { $project: { contactId: 1, jobId: 1, stageId: 1, score: 1, appliedAt: 1 } },
  ]).toArray();

  // In-app contact join: contacts have no per-company secondary index beyond
  // (companyId, email) — an _id batch fetch is index-covered and clearer than $lookup.
  const contactById = await mapContactsById(companyOid, rows.map((row) => row.contactId));
  return rows.map((row) => {
    const contact = contactById.get(row.contactId?.toString()) ?? { name: null, email: null };
    return {
      applicationId: row._id.toString(),
      contactName: contact.name,
      contactEmail: contact.email,
      postingTitle: postingTitleById.get(row.jobId?.toString()) ?? null,
      stage: stageNameById.get(row.stageId?.toString()) ?? null,
      score: typeof row.score === 'number' ? row.score : null,
      appliedAt: row.appliedAt,
    };
  });
}

/** Assemble the whole dashboard summary for one company in one response. */
export async function buildDashboardSummary(companyId, { now = new Date(), attentionDeps = {} } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('buildDashboardSummary: invalid companyId');

  const jobsCollection = await col('jobs');
  const postings = await jobsCollection
    .find({ companyId: companyOid, source: NATIVE_SOURCE, status: 'active' })
    .project({ title: 1, location: 1, workplaceType: 1, createdAt: 1 })
    .toArray();
  const postingIds = postings.map((posting) => posting._id);
  const postingTitleById = new Map(postings.map((posting) => [posting._id.toString(), posting.title]));

  const [stats, stageNameById, hiredStageIds, interviewsThisWeek, newThisWeek] = await Promise.all([
    aggregateApplicantStats(companyOid, postingIds),
    mapStageNamesById(companyOid),
    listHiredStageIds(companyOid),
    countInterviewsThisWeek(companyOid, now),
    countNewApplicationsThisWeek(companyOid, now),
  ]);

  const statsByJob = new Map();
  let totalApplicants = 0; let scoreSum = 0; let scoredCount = 0; let strongMatches = 0;
  for (const row of stats) {
    const jobKey = row._id.jobId?.toString();
    const entry = statsByJob.get(jobKey) ?? { count: 0, stageCounts: emptyStageCounts() };
    entry.count += row.count;
    const stageKey = String(stageNameById.get(row._id.stageId?.toString()) ?? '').trim().toLowerCase();
    if (STAGE_KEYS.includes(stageKey)) entry.stageCounts[stageKey] += row.count;
    statsByJob.set(jobKey, entry);
    totalApplicants += row.count;
    scoreSum += row.scoreSum;
    scoredCount += row.scoredCount;
    strongMatches += row.strongCount;
  }

  const activeJobs = postings.map((posting) => {
    const entry = statsByJob.get(posting._id.toString()) ?? { count: 0, stageCounts: emptyStageCounts() };
    return {
      id: posting._id.toString(),
      title: posting.title,
      location: posting.location ?? null,
      workplaceType: posting.workplaceType ?? null,
      applicantCount: entry.count,
      daysOpen: daysBetween(posting.createdAt ?? now, now),
      stageCounts: entry.stageCounts,
    };
  });

  // Best-effort: a broken attention detector must never fail the summary.
  const [avgDaysToHire, topCandidates, needsAttention] = await Promise.all([
    averageDaysToHire(companyOid, hiredStageIds),
    loadTopCandidates(companyOid, postingIds, postingTitleById, stageNameById),
    buildNeedsAttention(companyOid, { now, postings, deps: attentionDeps })
      .catch((err) => { console.warn(`[dashboard] needs-attention failed: ${err.message}`); return []; }),
  ]);

  return {
    kpis: {
      activeJobs: postings.length,
      totalApplicants,
      newThisWeek,
      interviewsThisWeek,
      avgAiScore: scoredCount > 0 ? Math.round((scoreSum / scoredCount) * 10) / 10 : null,
      avgDaysToHire,
      strongMatches,
    },
    activeJobs,
    topCandidates,
    needsAttention,
  };
}
