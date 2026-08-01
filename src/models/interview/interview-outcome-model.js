// FILE: src/models/interview/interview-outcome-model.js
// Post-interview outcomes: complete-with-feedback and no-show. Split out of
// interview-model.js (file-size rule). Every read/write is companyId-scoped
// (§6.5). Guards return { error } objects rather than throwing so the service
// layer can map them to precise HTTP codes; the final write is a guarded
// findOneAndUpdate, so a concurrent state change loses the race safely.

import { ObjectId } from 'mongodb';
import { interviewsCol } from './interview-model.js';
import {
  INTERVIEW_STATUSES, INTERVIEW_RECOMMENDATIONS, FEEDBACK_TEXT_MINIMUM_LENGTH,
  INTERVIEW_ERROR_CODES,
} from './interview-constants.js';
import { recycleTimeFromCancelledInterview } from './interview-time-booking-model.js';

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/**
 * Shared guard: the interview must exist in this company, be 'scheduled', and
 * its start time must be in the past. Returns { interview } or { error }.
 */
async function loadCompletableInterview(companyId, interviewId, now) {
  const companyOid = toOid(companyId);
  const interviewOid = toOid(interviewId);
  if (!companyOid || !interviewOid) return { error: INTERVIEW_ERROR_CODES.INTERVIEW_NOT_FOUND };

  const interview = await (await interviewsCol()).findOne({ companyId: companyOid, _id: interviewOid });
  if (!interview) return { error: INTERVIEW_ERROR_CODES.INTERVIEW_NOT_FOUND };
  if (interview.status !== INTERVIEW_STATUSES.SCHEDULED) {
    return { error: INTERVIEW_ERROR_CODES.INTERVIEW_NOT_SCHEDULED };
  }
  if (!interview.startAtUtc || interview.startAtUtc > now) {
    return { error: INTERVIEW_ERROR_CODES.INTERVIEW_NOT_YET };
  }
  return { interview, companyOid, interviewOid };
}

/**
 * Mark a past scheduled interview completed with the interviewer's verdict.
 * Returns { interview } or { error }.
 */
export async function completeInterview(companyId, interviewId, { recommendation, feedbackText, actorUserId } = {}) {
  if (!Object.values(INTERVIEW_RECOMMENDATIONS).includes(recommendation)) {
    return { error: INTERVIEW_ERROR_CODES.INVALID_RECOMMENDATION };
  }
  if (typeof feedbackText !== 'string' || feedbackText.trim().length < FEEDBACK_TEXT_MINIMUM_LENGTH) {
    return { error: INTERVIEW_ERROR_CODES.FEEDBACK_TOO_SHORT };
  }

  const now = new Date();
  const guard = await loadCompletableInterview(companyId, interviewId, now);
  if (guard.error) return guard;

  const updated = await (await interviewsCol()).findOneAndUpdate(
    {
      companyId: guard.companyOid,
      _id: guard.interviewOid,
      status: INTERVIEW_STATUSES.SCHEDULED,
      startAtUtc: { $lte: now },
    },
    {
      $set: {
        status: INTERVIEW_STATUSES.COMPLETED,
        completedAt: now,
        recommendation,
        feedbackText: feedbackText.trim(),
        completedByUserId: toOid(actorUserId),
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  // Lost the race to a concurrent cancel/complete — report the state honestly.
  if (!updated) return { error: INTERVIEW_ERROR_CODES.INTERVIEW_NOT_SCHEDULED };
  return { interview: updated };
}

/**
 * Mark a past scheduled interview as a candidate no-show and recycle any pool
 * time it held (best-effort — manual interviews hold none). Returns
 * { interview } or { error }.
 */
export async function markInterviewNoShow(companyId, interviewId, { note, actorUserId } = {}) {
  const now = new Date();
  const guard = await loadCompletableInterview(companyId, interviewId, now);
  if (guard.error) return guard;

  const updated = await (await interviewsCol()).findOneAndUpdate(
    {
      companyId: guard.companyOid,
      _id: guard.interviewOid,
      status: INTERVIEW_STATUSES.SCHEDULED,
      startAtUtc: { $lte: now },
    },
    {
      $set: {
        status: INTERVIEW_STATUSES.NO_SHOW,
        noShowAt: now,
        noShowNote: typeof note === 'string' && note.trim() ? note.trim() : null,
        markedByUserId: toOid(actorUserId),
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) return { error: INTERVIEW_ERROR_CODES.INTERVIEW_NOT_SCHEDULED };

  // A pool interview's slot goes back to the pool; a manual interview matches
  // nothing and returns null. Never fails the no-show itself.
  try {
    await recycleTimeFromCancelledInterview(updated._id);
  } catch (err) {
    console.warn(`[interview] no-show pool-time recycle failed: ${err.message}`);
  }
  return { interview: updated };
}
