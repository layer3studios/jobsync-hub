// FILE: src/models/interview/interview-time-booking-model.js
// Atomic pool-time booking + recycling, split from interview-time-model.js
// (file-size rule). Each time is its own document, so two candidates racing for
// the same time contend on ONE doc's status predicate and nothing else: the
// first findOneAndUpdate flips 'available' → 'booked', the second matches
// nothing. The public candidate list also lives here — see the field
// restriction note on listAvailableTimesForPublicBooking.

import {
  interviewTimesCol, toOid, leadTimeCutoff, INTERVIEW_TIME_STATUSES,
} from './interview-time-model.js';
import { INTERVIEW_ERROR_CODES } from './interview-constants.js';

/**
 * Unauthenticated candidate list — NO companyId (the candidate has none; the
 * postingId comes from the interview reached via the booking token). Returns
 * ONLY id, startAtUtc, durationMinutes, timezoneId: mode/meetingUrl/
 * locationText/companyId must never reach an unbooked candidate.
 */
export async function listAvailableTimesForPublicBooking(postingId, now = new Date()) {
  const postingOid = toOid(postingId);
  if (!postingOid) return [];
  const rows = await (await interviewTimesCol())
    .find({
      postingId: postingOid,
      status: INTERVIEW_TIME_STATUSES.AVAILABLE,
      startAtUtc: { $gt: leadTimeCutoff(now) },
    })
    .sort({ startAtUtc: 1 })
    .toArray();
  return rows.map((row) => ({
    id: row._id.toString(),
    startAtUtc: row.startAtUtc,
    durationMinutes: row.durationMinutes,
    timezoneId: row.timezoneId,
  }));
}

/**
 * THE CRITICAL FUNCTION. One findOneAndUpdate whose filter asserts the time is
 * still available AND still outside the lead window. Never throws for expected
 * conditions — returns { booked: true, time } or { booked: false, code }.
 */
export async function bookTimeAtomically(timeId, applicationId, interviewId, now = new Date()) {
  const timeOid = toOid(timeId);
  if (!timeOid) return { booked: false, code: INTERVIEW_ERROR_CODES.TIME_NOT_FOUND };
  const collection = await interviewTimesCol();
  const time = await collection.findOneAndUpdate(
    {
      _id: timeOid,
      status: INTERVIEW_TIME_STATUSES.AVAILABLE,
      startAtUtc: { $gt: leadTimeCutoff(now) },
    },
    {
      $set: {
        status: INTERVIEW_TIME_STATUSES.BOOKED,
        bookedByApplicationId: toOid(applicationId),
        bookedByInterviewId: toOid(interviewId),
        bookedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (time) return { booked: true, time };

  // Matched nothing — one follow-up read to say why.
  const current = await collection.findOne({ _id: timeOid });
  if (!current) return { booked: false, code: INTERVIEW_ERROR_CODES.TIME_NOT_FOUND };
  if (current.status === INTERVIEW_TIME_STATUSES.BOOKED) return { booked: false, code: INTERVIEW_ERROR_CODES.TIME_ALREADY_BOOKED };
  if (current.status === INTERVIEW_TIME_STATUSES.AVAILABLE) return { booked: false, code: INTERVIEW_ERROR_CODES.TIME_TOO_SOON };
  return { booked: false, code: INTERVIEW_ERROR_CODES.TIME_NOT_FOUND };
}

/**
 * Put a cancelled/no-show interview's time back in the pool. Returns the
 * recycled time, or null when the interview wasn't pool-based.
 */
export async function recycleTimeFromCancelledInterview(interviewId) {
  const interviewOid = toOid(interviewId);
  if (!interviewOid) return null;
  return (await interviewTimesCol()).findOneAndUpdate(
    { bookedByInterviewId: interviewOid, status: INTERVIEW_TIME_STATUSES.BOOKED },
    {
      $set: {
        status: INTERVIEW_TIME_STATUSES.AVAILABLE,
        bookedByApplicationId: null,
        bookedByInterviewId: null,
        bookedAt: null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}
