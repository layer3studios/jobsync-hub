// FILE: src/services/employer/candidate-timeline-service.js
// One merged, newest-first timeline for an application: applied, scored, stage
// moves, interview lifecycle, notes. The application ownership check runs
// FIRST — every follow-up read either carries companyId itself or keys off the
// verified application's id (stage_changes has no companyId column). The
// response carries NO internal ids: names and stage texts only.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { getApplicationForCompany as defaultGetApplication } from '../../models/public/application-model.js';
import { listStagesForCompany as defaultListStages } from '../../models/employer/stage-model.js';
import { listInterviewsForApplication as defaultListInterviews } from '../../models/interview/interview-model.js';
import { listApplicantNotesForApplication as defaultListNotes } from '../../models/public/applicant-note-model.js';
import { listStageChangesForApplication as defaultListStageChanges } from '../../models/public/stage-change-model.js';
import { INTERVIEW_STATUSES } from '../../models/interview/interview-constants.js';

/** Batch-load employer user names → Map(idString → name). Never N+1. */
async function mapActorNamesById(actorIds) {
  const ids = [...new Set(actorIds.filter(Boolean).map((id) => id.toString()))];
  if (ids.length === 0) return new Map();
  const docs = await (await col('employer_users'))
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .project({ name: 1 })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toString(), doc.name ?? null]));
}

/** Every event one interview contributes, per its recorded lifecycle stamps. */
function interviewEvents(interview) {
  const events = [{ type: 'interview_proposed', timestamp: interview.createdAt }];
  if (interview.bookedAt) {
    events.push({ type: 'interview_booked', bookedTime: interview.startAtUtc ?? null, timestamp: interview.bookedAt });
  }
  if (interview.status === INTERVIEW_STATUSES.COMPLETED && interview.completedAt) {
    events.push({
      type: 'interview_completed',
      recommendation: interview.recommendation ?? null,
      feedbackText: interview.feedbackText ?? null,
      timestamp: interview.completedAt,
    });
  }
  if (interview.status === INTERVIEW_STATUSES.NO_SHOW && interview.noShowAt) {
    events.push({ type: 'interview_no_show', timestamp: interview.noShowAt });
  }
  if (interview.status === INTERVIEW_STATUSES.CANCELLED && interview.cancelledAt) {
    events.push({ type: 'interview_cancelled', timestamp: interview.cancelledAt });
  }
  return events;
}

/** Merged timeline, newest first. Cross-tenant / unknown application → []. */
export async function buildCandidateTimeline(companyId, applicationId, deps = {}) {
  const {
    getApplication = defaultGetApplication,
    listStages = defaultListStages,
    listInterviews = defaultListInterviews,
    listNotes = defaultListNotes,
    listStageChanges = defaultListStageChanges,
    mapActorNames = mapActorNamesById,
  } = deps;

  const application = await getApplication(companyId, applicationId);
  if (!application) return [];

  const [stages, interviews, notes, stageChanges, scoreJobs, scores] = await Promise.all([
    listStages(companyId),
    listInterviews(companyId, application._id),
    listNotes(companyId, application._id),
    listStageChanges(application._id),
    (await col('resume_score_jobs'))
      .find({ companyId: application.companyId, applicationId: application._id, status: 'done' })
      .project({ completedAt: 1 }).toArray(),
    (await col('resume_scores'))
      .find({ companyId: application.companyId, applicationId: application._id })
      .project({ score: 1 }).toArray(),
  ]);
  const stageNameById = new Map(stages.map((stage) => [stage._id.toString(), stage.text]));
  const actorNameById = await mapActorNames(stageChanges.map((change) => change.movedByUserId));

  const events = [
    { type: 'applied', timestamp: application.createdAt },
    ...scoreJobs.filter((job) => job.completedAt).map((job) => ({
      type: 'scored', score: scores[0]?.score ?? null, timestamp: job.completedAt,
    })),
    // fromStageId null = the initial system placement, already covered by 'applied'.
    ...stageChanges.filter((change) => change.fromStageId).map((change) => ({
      type: 'stage_move',
      fromStage: stageNameById.get(change.fromStageId?.toString()) ?? null,
      toStage: stageNameById.get(change.toStageId?.toString()) ?? null,
      actorName: actorNameById.get(change.movedByUserId?.toString()) ?? null,
      timestamp: change.movedAt,
    })),
    ...interviews.flatMap(interviewEvents),
    ...notes.map((note) => ({
      type: 'note_added', text: note.body, authorName: note.authorName ?? null, timestamp: note.createdAt,
    })),
  ];

  return events
    .filter((event) => event.timestamp instanceof Date)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}
