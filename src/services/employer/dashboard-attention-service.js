// FILE: src/services/employer/dashboard-attention-service.js
// "Needs attention" feed for the dashboard summary: actionable items only.
// Every query puts companyId FIRST in the filter (§6.5). Best-effort by
// design: each item type loads in its own try/catch — one broken detector
// logs a warning and drops out; it never fails the summary.

import { col } from '../../Db/connection.js';
import { listStagesForCompany } from '../../models/employer/stage-model.js';
import { INTERVIEW_TIME_STATUSES } from '../../models/interview/interview-time-model.js';
import { mapContactsById } from './dashboard-helpers.js';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const UNREVIEWED_AGE_HOURS = 48;
const STALE_AGE_DAYS = 14;
const UPCOMING_WINDOW_HOURS = 48;
const STALE_LIMIT = 5;
const UPCOMING_LIMIT = 3;
const LOW_POOL_THRESHOLD = 1;

/** The stage new applications land in: the default stage, else "Applied". */
const findAppliedStage = (stages) => stages.find((s) => s.isDefault)
  ?? stages.find((s) => String(s.text ?? '').trim().toLowerCase() === 'applied')
  ?? null;

async function loadUnreviewed(companyOid, appliedStageId, postingTitleById, now) {
  if (!appliedStageId) return [];
  const cutoff = new Date(now.getTime() - UNREVIEWED_AGE_HOURS * HOUR_MS);
  const rows = await (await col('applications')).aggregate([
    { $match: { companyId: companyOid, stageId: appliedStageId, archived: null, lastStageMovedAt: { $lt: cutoff } } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]).toArray();
  return rows
    .filter((row) => postingTitleById.has(row._id?.toString()))
    .map((row) => ({
      type: 'unreviewed',
      postingId: row._id.toString(),
      postingTitle: postingTitleById.get(row._id.toString()),
      count: row.count,
    }));
}

async function loadStale(companyOid, appliedStageId, terminalStageIds, stageNameById, postingTitleById, now) {
  const excluded = [appliedStageId, ...terminalStageIds].filter(Boolean);
  const cutoff = new Date(now.getTime() - STALE_AGE_DAYS * DAY_MS);
  const docs = await (await col('applications'))
    .find({ companyId: companyOid, stageId: { $nin: excluded }, archived: null, lastStageMovedAt: { $lt: cutoff } })
    .sort({ lastStageMovedAt: 1 }).limit(STALE_LIMIT)
    .project({ contactId: 1, jobId: 1, stageId: 1, lastStageMovedAt: 1 })
    .toArray();
  const contactById = await mapContactsById(companyOid, docs.map((doc) => doc.contactId));
  return docs.map((doc) => ({
    type: 'stale',
    applicationId: doc._id.toString(),
    contactName: contactById.get(doc.contactId?.toString())?.name ?? null,
    postingTitle: postingTitleById.get(doc.jobId?.toString()) ?? null,
    stage: stageNameById.get(doc.stageId?.toString()) ?? null,
    daysInStage: Math.floor((now.getTime() - doc.lastStageMovedAt.getTime()) / DAY_MS),
  }));
}

/** Mirrors pool-monitor-service: pools that exist but have ≤1 future available time. */
async function loadPoolLow(companyOid, postingIds, postingTitleById, now) {
  if (postingIds.length === 0) return [];
  const rows = await (await col('interview_times')).aggregate([
    { $match: { companyId: companyOid, postingId: { $in: postingIds } } },
    { $group: {
      _id: '$postingId',
      availableCount: { $sum: { $cond: [{ $and: [
        { $eq: ['$status', INTERVIEW_TIME_STATUSES.AVAILABLE] },
        { $gt: ['$startAtUtc', now] },
      ] }, 1, 0] } },
    } },
    { $match: { availableCount: { $lte: LOW_POOL_THRESHOLD } } },
  ]).toArray();
  return rows.map((row) => ({
    type: 'pool_low',
    postingId: row._id.toString(),
    postingTitle: postingTitleById.get(row._id.toString()) ?? null,
    availableCount: row.availableCount,
  }));
}

async function loadUpcoming(companyOid, postingTitleById, now) {
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_HOURS * HOUR_MS);
  const docs = await (await col('interviews'))
    .find({ companyId: companyOid, status: 'scheduled', startAtUtc: { $gte: now, $lte: windowEnd } })
    .sort({ startAtUtc: 1 }).limit(UPCOMING_LIMIT)
    .project({ contactId: 1, postingId: 1, startAtUtc: 1, meetingUrl: 1 })
    .toArray();
  const contactById = await mapContactsById(companyOid, docs.map((doc) => doc.contactId));
  return docs.map((doc) => ({
    type: 'upcoming_interview',
    interviewId: doc._id.toString(),
    candidateName: contactById.get(doc.contactId?.toString())?.name ?? null,
    postingTitle: postingTitleById.get(doc.postingId?.toString()) ?? null,
    startAtUtc: doc.startAtUtc,
    meetingUrl: doc.meetingUrl ?? null,
  }));
}

/**
 * Assemble the needs-attention array, ordered upcoming_interview →
 * unreviewed → stale → pool_low. `deps` lets tests break one detector; a
 * throwing detector is logged and skipped, never propagated.
 */
export async function buildNeedsAttention(companyId, { now = new Date(), postings = [], deps = {} } = {}) {
  const companyOid = companyId; // callers pass the ObjectId from the summary service
  const postingIds = postings.map((posting) => posting._id);
  const postingTitleById = new Map(postings.map((posting) => [posting._id.toString(), posting.title]));

  const stages = await listStagesForCompany(companyOid);
  const stageNameById = new Map(stages.map((stage) => [stage._id.toString(), stage.text]));
  const appliedStageId = findAppliedStage(stages)?._id ?? null;
  const terminalStageIds = stages.filter((stage) => stage.isTerminal || stage.terminalType).map((stage) => stage._id);

  const detectors = [
    ['upcoming_interview', deps.loadUpcoming ?? (() => loadUpcoming(companyOid, postingTitleById, now))],
    ['unreviewed', deps.loadUnreviewed ?? (() => loadUnreviewed(companyOid, appliedStageId, postingTitleById, now))],
    ['stale', deps.loadStale ?? (() => loadStale(companyOid, appliedStageId, terminalStageIds, stageNameById, postingTitleById, now))],
    ['pool_low', deps.loadPoolLow ?? (() => loadPoolLow(companyOid, postingIds, postingTitleById, now))],
  ];

  const items = [];
  for (const [name, detector] of detectors) {
    try {
      items.push(...await detector());
    } catch (err) {
      console.warn(`[dashboard-attention] ${name} detection failed: ${err.message}`);
    }
  }
  return items;
}
