// FILE: src/services/employer/dashboard-activity-service.js
// Recent-activity feed, Option A: each source collection is queried separately
// (companyId FIRST in every filter, §6.5), merged in-app, sorted, trimmed.
// Option B (audit_log) was rejected: audit_log docs carry no companyId, so a
// tenant-scoped query there is impossible without a join.
//
// stage_changes has no companyId either — stage-move events are derived from
// the company's applications (lastStageMovedAt) and their per-application
// stage_changes rows (indexed by applicationId), never a cross-tenant scan.
// Contacts are batch-loaded once for the merged result set — no N+1.

import { col } from '../../Db/connection.js';
import {
  toOid, mapContactsById, mapPostingTitlesById, mapStageNamesById,
} from './dashboard-helpers.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Recent applications → 'application' events. */
async function loadApplicationEvents(companyOid, limit) {
  const collection = await col('applications');
  const docs = await collection.find({ companyId: companyOid })
    .sort({ appliedAt: -1 }).limit(limit)
    .project({ contactId: 1, jobId: 1, appliedAt: 1 })
    .toArray();
  return docs.map((doc) => ({
    type: 'application', contactId: doc.contactId, jobId: doc.jobId, timestamp: doc.appliedAt,
  }));
}

/** Latest real stage move (fromStageId != null) per recently-moved application. */
async function loadStageMoveEvents(companyOid, limit) {
  const applications = await col('applications');
  const recentlyMoved = await applications.find({ companyId: companyOid })
    .sort({ lastStageMovedAt: -1 }).limit(limit)
    .project({ contactId: 1, jobId: 1, lastStageMovedAt: 1 })
    .toArray();
  if (recentlyMoved.length === 0) return [];

  const changes = await (await col('stage_changes'))
    .find({ applicationId: { $in: recentlyMoved.map((doc) => doc._id) }, fromStageId: { $ne: null } })
    .sort({ movedAt: -1 })
    .toArray();
  const latestByApp = new Map();
  for (const change of changes) {
    const key = change.applicationId.toString();
    if (!latestByApp.has(key)) latestByApp.set(key, change);
  }

  return recentlyMoved.flatMap((doc) => {
    const change = latestByApp.get(doc._id.toString());
    if (!change) return [];
    return [{
      type: 'stage_move', contactId: doc.contactId, jobId: doc.jobId,
      fromStageId: change.fromStageId, toStageId: change.toStageId, timestamp: change.movedAt,
    }];
  });
}

/** Scheduled / cancelled interviews → booking events. */
async function loadInterviewEvents(companyOid, limit) {
  const collection = await col('interviews');
  const [scheduled, cancelled] = await Promise.all([
    collection.find({ companyId: companyOid, status: 'scheduled' })
      .sort({ bookedAt: -1 }).limit(limit)
      .project({ contactId: 1, postingId: 1, startAtUtc: 1, bookedAt: 1, createdAt: 1 })
      .toArray(),
    collection.find({ companyId: companyOid, status: 'cancelled' })
      .sort({ cancelledAt: -1 }).limit(limit)
      .project({ contactId: 1, postingId: 1, cancelledAt: 1, updatedAt: 1 })
      .toArray(),
  ]);
  return [
    ...scheduled.map((doc) => ({
      type: 'interview_booked', contactId: doc.contactId, jobId: doc.postingId,
      interviewTime: doc.startAtUtc ?? null, timestamp: doc.bookedAt ?? doc.createdAt,
    })),
    ...cancelled.map((doc) => ({
      type: 'interview_cancelled', contactId: doc.contactId, jobId: doc.postingId,
      timestamp: doc.cancelledAt ?? doc.updatedAt,
    })),
  ];
}

/** Completed score jobs (24h TTL collection — inherently small) → score events. */
async function loadScoreEvents(companyOid, limit) {
  const jobs = await (await col('resume_score_jobs'))
    .find({ companyId: companyOid, status: 'done' })
    .sort({ completedAt: -1 }).limit(limit)
    .project({ applicationId: 1, completedAt: 1 })
    .toArray();
  if (jobs.length === 0) return [];

  const appIds = jobs.map((job) => job.applicationId).filter(Boolean);
  const [apps, scores] = await Promise.all([
    (await col('applications'))
      .find({ companyId: companyOid, _id: { $in: appIds } })
      .project({ contactId: 1, jobId: 1 }).toArray(),
    (await col('resume_scores'))
      .find({ companyId: companyOid, applicationId: { $in: appIds } })
      .project({ applicationId: 1, score: 1 }).toArray(),
  ]);
  const appById = new Map(apps.map((doc) => [doc._id.toString(), doc]));
  const scoreByApp = new Map(scores.map((doc) => [doc.applicationId.toString(), doc.score ?? null]));

  return jobs.flatMap((job) => {
    const app = appById.get(job.applicationId?.toString());
    if (!app) return []; // cross-tenant or deleted application — never leaks
    return [{
      type: 'score_completed', contactId: app.contactId, jobId: app.jobId,
      score: scoreByApp.get(job.applicationId.toString()) ?? null, timestamp: job.completedAt,
    }];
  });
}

/** Merge all sources, resolve names, strip every internal id. */
export async function buildDashboardActivity(companyId, { limit = DEFAULT_LIMIT } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('buildDashboardActivity: invalid companyId');
  const cappedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  const [applications, stageMoves, interviews, scoreEvents, stageNameById] = await Promise.all([
    loadApplicationEvents(companyOid, cappedLimit),
    loadStageMoveEvents(companyOid, cappedLimit),
    loadInterviewEvents(companyOid, cappedLimit),
    loadScoreEvents(companyOid, cappedLimit),
    mapStageNamesById(companyOid),
  ]);

  const merged = [...applications, ...stageMoves, ...interviews, ...scoreEvents]
    .filter((event) => event.timestamp instanceof Date)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, cappedLimit);

  const [contactById, postingTitleById] = await Promise.all([
    mapContactsById(companyOid, merged.map((event) => event.contactId)),
    mapPostingTitlesById(companyOid, merged.map((event) => event.jobId)),
  ]);

  return merged.map((event) => {
    const contact = contactById.get(event.contactId?.toString()) ?? { name: null };
    const base = {
      type: event.type,
      candidateName: contact.name,
      postingTitle: postingTitleById.get(event.jobId?.toString()) ?? null,
      timestamp: event.timestamp,
    };
    if (event.type === 'stage_move') {
      base.fromStage = stageNameById.get(event.fromStageId?.toString()) ?? null;
      base.toStage = stageNameById.get(event.toStageId?.toString()) ?? null;
    }
    if (event.type === 'interview_booked') base.interviewTime = event.interviewTime;
    if (event.type === 'score_completed') base.score = event.score;
    return base;
  });
}
