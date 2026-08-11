// FILE: src/services/employer/company-activity-service.js
// Company-wide activity feed — who did what, to which candidate, on which posting.
// Distinct from dashboard-activity-service (a short at-a-glance strip with no
// actors): this one names the person behind each event and pages backwards
// through history.
//
// Every source is queried companyId-first (§6.5). stage_changes carries no
// companyId, so its rows are reached only through the company's own applications —
// never scanned globally. That bounds the feed to activity on the company's
// RECENTLY-TOUCHED applications, which is exactly what a recent-activity feed is.

import { col } from '../../Db/connection.js';
import { toOid, mapContactsById, mapPostingTitlesById, mapStageNamesById } from './dashboard-helpers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
/** How many of the company's applications the stage-move join reaches back over. */
const APPLICATION_WINDOW = 400;

/** A stage_change written by the archive service rather than a real move. */
const isArchiveNote = (note) => typeof note === 'string' && note.startsWith('Archived:');

/** Applications the company touched most recently — the join key for stage moves. */
async function loadRecentApplications(companyOid, before) {
  const collection = await col('applications');
  const query = { companyId: companyOid };
  if (before) query.lastStageMovedAt = { $lt: before };
  return collection.find(query)
    .sort({ lastStageMovedAt: -1 }).limit(APPLICATION_WINDOW)
    .project({ contactId: 1, jobId: 1, appliedAt: 1 })
    .toArray();
}

/** New applications → application_received events. Nobody "did" these. */
async function loadApplicationEvents(companyOid, before, limit) {
  const collection = await col('applications');
  const query = { companyId: companyOid };
  if (before) query.appliedAt = { $lt: before };
  const docs = await collection.find(query)
    .sort({ appliedAt: -1 }).limit(limit)
    .project({ contactId: 1, jobId: 1, appliedAt: 1 })
    .toArray();
  return docs.map((doc) => ({
    type: 'application_received',
    applicationId: doc._id, contactId: doc.contactId, jobId: doc.jobId,
    actorUserId: null, timestamp: doc.appliedAt,
  }));
}

/** stage_changes on those applications → stage_move + archive events. */
async function loadStageEvents(applications, before, limit) {
  if (applications.length === 0) return [];
  const appById = new Map(applications.map((doc) => [doc._id.toString(), doc]));
  const query = {
    applicationId: { $in: applications.map((doc) => doc._id) },
    fromStageId: { $ne: null },
  };
  if (before) query.movedAt = { $lt: before };

  const changes = await (await col('stage_changes'))
    .find(query).sort({ movedAt: -1 }).limit(limit * 2)
    .toArray();

  return changes.map((change) => {
    const application = appById.get(change.applicationId.toString());
    const archived = isArchiveNote(change.note);
    return {
      type: archived ? 'archive' : 'stage_move',
      applicationId: change.applicationId,
      contactId: application?.contactId ?? null,
      jobId: application?.jobId ?? null,
      fromStageId: change.fromStageId, toStageId: change.toStageId,
      note: change.note ?? null,
      actorUserId: change.movedByUserId ?? null,
      timestamp: change.movedAt,
    };
  });
}

/** Notes → note events. applicant_notes carries companyId and the author snapshot. */
async function loadNoteEvents(companyOid, before, limit) {
  const query = { companyId: companyOid };
  if (before) query.createdAt = { $lt: before };
  const notes = await (await col('applicant_notes'))
    .find(query).sort({ createdAt: -1 }).limit(limit)
    .toArray();
  if (notes.length === 0) return [];

  const applications = await (await col('applications'))
    .find({ companyId: companyOid, _id: { $in: notes.map((note) => note.applicationId) } })
    .project({ contactId: 1, jobId: 1 })
    .toArray();
  const appById = new Map(applications.map((doc) => [doc._id.toString(), doc]));

  return notes.flatMap((note) => {
    const application = appById.get(note.applicationId?.toString());
    if (!application) return []; // deleted or cross-tenant — never leaks
    return [{
      type: 'note',
      applicationId: note.applicationId,
      contactId: application.contactId, jobId: application.jobId,
      note: String(note.body ?? '').slice(0, 140),
      actorUserId: note.authorEmployerUserId ?? null,
      actorNameSnapshot: note.authorName ?? note.authorEmail ?? null,
      timestamp: note.createdAt,
    }];
  });
}

/** Booked interviews → interview_scheduled events. */
async function loadInterviewEvents(companyOid, before, limit) {
  const query = { companyId: companyOid, status: 'scheduled' };
  if (before) query.bookedAt = { $lt: before };
  const docs = await (await col('interviews'))
    .find(query).sort({ bookedAt: -1 }).limit(limit)
    .project({ contactId: 1, postingId: 1, applicationId: 1, startAtUtc: 1, bookedAt: 1, createdAt: 1 })
    .toArray();
  return docs.map((doc) => ({
    type: 'interview_scheduled',
    applicationId: doc.applicationId ?? null,
    contactId: doc.contactId, jobId: doc.postingId,
    interviewTime: doc.startAtUtc ?? null,
    actorUserId: null, timestamp: doc.bookedAt ?? doc.createdAt,
  }));
}

/** Batch-load actor display names → Map(idString → name). */
async function mapActorNamesById(actorIds) {
  const ids = [...new Set(actorIds.filter(Boolean).map(String))].map(toOid).filter(Boolean);
  if (ids.length === 0) return new Map();
  const docs = await (await col('employer_users'))
    .find({ _id: { $in: ids } })
    .project({ fullName: 1, name: 1, email: 1 })
    .toArray();
  return new Map(docs.map((doc) => [
    doc._id.toString(), doc.fullName ?? doc.name ?? doc.email ?? null,
  ]));
}

/**
 * Build the feed. `viewerRole` + `viewerUserId` narrow it for interviewers, who see
 * only what they themselves did — an interviewer is brought in for specific
 * candidates, not given a window onto the whole company's hiring.
 */
export async function buildCompanyActivity(companyId, {
  limit = DEFAULT_LIMIT, before = null, viewerRole = 'member', viewerUserId = null,
} = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('buildCompanyActivity: invalid companyId');
  const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const cursor = before ? new Date(before) : null;
  const beforeDate = cursor && !Number.isNaN(cursor.getTime()) ? cursor : null;

  const applications = await loadRecentApplications(companyOid, beforeDate);
  const [received, stageEvents, notes, interviews, stageNameById] = await Promise.all([
    loadApplicationEvents(companyOid, beforeDate, capped),
    loadStageEvents(applications, beforeDate, capped),
    loadNoteEvents(companyOid, beforeDate, capped),
    loadInterviewEvents(companyOid, beforeDate, capped),
    mapStageNamesById(companyOid),
  ]);

  let merged = [...received, ...stageEvents, ...notes, ...interviews]
    .filter((event) => event.timestamp instanceof Date);
  if (viewerRole === 'interviewer') {
    const viewer = viewerUserId ? String(viewerUserId) : null;
    merged = merged.filter((event) => event.actorUserId && String(event.actorUserId) === viewer);
  }
  merged = merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, capped);

  const [contactById, postingTitleById, actorNameById] = await Promise.all([
    mapContactsById(companyOid, merged.map((event) => event.contactId)),
    mapPostingTitlesById(companyOid, merged.map((event) => event.jobId)),
    mapActorNamesById(merged.map((event) => event.actorUserId)),
  ]);

  const items = merged.map((event) => ({
    type: event.type,
    applicationId: event.applicationId?.toString() ?? null,
    candidateName: contactById.get(event.contactId?.toString())?.name ?? null,
    postingTitle: postingTitleById.get(event.jobId?.toString()) ?? null,
    actorName: actorNameById.get(event.actorUserId?.toString())
      ?? event.actorNameSnapshot ?? null,
    timestamp: event.timestamp,
    details: {
      fromStage: stageNameById.get(event.fromStageId?.toString()) ?? null,
      toStage: stageNameById.get(event.toStageId?.toString()) ?? null,
      note: event.note ?? null,
      interviewTime: event.interviewTime ?? null,
    },
  }));

  // The cursor for the next page is the oldest item on this one. null means the
  // feed is exhausted, which is what stops the client asking again.
  const nextBefore = items.length === capped ? items[items.length - 1].timestamp : null;
  return { items, nextBefore };
}

export default buildCompanyActivity;
