// FILE: src/services/interview/interview-pool-booking-service.js
// Pool-path candidate booking + the body dispatcher used by the public route.
// Two atomic steps: claim the interview_times doc (bookTimeAtomically), then
// flip the interview to scheduled (bookInterviewFromPoolTime, still guarded on
// status + token expiry). If the second step loses a race, the claimed time is
// recycled back to the pool — never stranded as booked.

import { findInterviewByBookingToken as defaultFindByToken } from '../../models/interview/interview-model.js';
import {
  bookTimeAtomically as defaultBookTime, recycleTimeFromCancelledInterview as defaultRecycleTime,
} from '../../models/interview/interview-time-booking-model.js';
import { bookInterviewFromPoolTime as defaultBookInterviewFromPool } from '../../models/interview/interview-booking-model.js';
import { INTERVIEW_STATUSES, INTERVIEW_ERROR_CODES } from '../../models/interview/interview-constants.js';
import {
  bookInterviewByToken, runPostBookingSideEffects, INTERVIEW_SOURCE_POOL,
} from './interview-booking-service.js';

function bookingFailure(code) {
  return { booked: false, interview: null, code };
}

/** Book one pool time by booking token + timeId. Never throws for expected conditions. */
export async function bookPoolInterviewByToken(token, timeId, deps = {}) {
  const {
    findByToken = defaultFindByToken,
    bookTime = defaultBookTime,
    bookInterviewFromPool = defaultBookInterviewFromPool,
    recycleTime = defaultRecycleTime,
  } = deps;
  const now = new Date();

  const interview = await findByToken(token);
  if (!interview) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID);
  if (interview.status !== INTERVIEW_STATUSES.PROPOSED) return bookingFailure(INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED);
  if (interview.bookingTokenExpiresAt <= now) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_EXPIRED);

  const claimed = await bookTime(timeId, interview.applicationId, interview._id, now);
  if (!claimed.booked) return bookingFailure(claimed.code);

  const updated = await bookInterviewFromPool(interview._id, claimed.time, now);
  if (!updated) {
    // Lost a race on the interview itself — free the time we just claimed.
    await recycleTime(interview._id);
    const current = await findByToken(token);
    if (current && current.bookingTokenExpiresAt <= now) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_EXPIRED);
    return bookingFailure(INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED);
  }

  await runPostBookingSideEffects(updated, deps);
  return { booked: true, interview: updated };
}

/**
 * Route-facing dispatcher: branch on the interview's source and reject a
 * mismatched body with a clear code — { timeId } for pool interviews,
 * { slotIndex } for per-candidate ones.
 */
export async function bookInterviewRequest(token, { slotIndex, timeId } = {}, deps = {}) {
  const { findByToken = defaultFindByToken } = deps;
  const interview = await findByToken(token);
  if (!interview) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID);

  if (interview.source === INTERVIEW_SOURCE_POOL) {
    if (slotIndex !== undefined || timeId === undefined) {
      return bookingFailure(INTERVIEW_ERROR_CODES.POOL_REQUIRES_TIME_ID);
    }
    return bookPoolInterviewByToken(token, timeId, deps);
  }
  if (timeId !== undefined || slotIndex === undefined) {
    return bookingFailure(INTERVIEW_ERROR_CODES.MANUAL_REQUIRES_SLOT_INDEX);
  }
  return bookInterviewByToken(token, Number(slotIndex), deps);
}
