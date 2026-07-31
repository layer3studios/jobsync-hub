// FILE: src/models/interview/interview-booking-model.js
// Atomic candidate slot booking, split out of interview-model.js (file-size
// rule). The single findOneAndUpdate whose filter asserts token + status +
// expiry is the real concurrency guard, mirroring claimNextScoreJob: two taps
// on a flaky mobile connection, or a double-click, cannot produce two bookings
// because the second attempt no longer matches status 'proposed'.
// Read-then-write is FORBIDDEN here; the pre-checks below are advisory only.

import { ObjectId } from 'mongodb';
import { interviewsCol, generateBookingToken } from './interview-model.js';
import {
  INTERVIEW_STATUSES, INTERVIEW_ERROR_CODES, MINIMUM_BOOKING_LEAD_MINUTES,
  BOOKING_TOKEN_TTL_DAYS,
} from './interview-constants.js';

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * MILLISECONDS_PER_MINUTE;

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

function bookingFailure(code) {
  return { booked: false, interview: null, code };
}

/**
 * Book one proposed slot by booking token. Never throws for expected
 * conditions. Returns { booked: true, interview, code: null } or
 * { booked: false, interview: null, code } with an INTERVIEW_ERROR_CODES value.
 */
export async function bookInterviewSlot(token, slotIndex, now = new Date()) {
  const collection = await interviewsCol();

  // Advisory pre-checks (they need a read; the atomic filter is the real guard).
  const existing = await collection.findOne({ bookingToken: token });
  if (!existing) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID);

  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= existing.proposedSlots.length) {
    return bookingFailure(INTERVIEW_ERROR_CODES.INVALID_SLOT);
  }
  const chosenSlot = existing.proposedSlots[slotIndex];
  const earliestAllowedStart = new Date(now.getTime() + MINIMUM_BOOKING_LEAD_MINUTES * MILLISECONDS_PER_MINUTE);
  if (chosenSlot.startAtUtc < earliestAllowedStart) {
    return bookingFailure(INTERVIEW_ERROR_CODES.SLOT_TOO_SOON);
  }

  // The atomic claim. Filter asserts token AND status AND expiry in one shot.
  const interview = await collection.findOneAndUpdate(
    {
      bookingToken: token,
      status: INTERVIEW_STATUSES.PROPOSED,
      bookingTokenExpiresAt: { $gt: now },
    },
    {
      $set: {
        status: INTERVIEW_STATUSES.SCHEDULED,
        selectedSlotIndex: slotIndex,
        startAtUtc: chosenSlot.startAtUtc,
        durationMinutes: chosenSlot.durationMinutes,
        bookedAt: now,
        updatedAt: now,
      },
      $inc: { calendarSequence: 1 },
    },
    { returnDocument: 'after' },
  );
  if (interview) return { booked: true, interview, code: null };

  // Matched nothing — one follow-up read to say why.
  const current = await collection.findOne({ bookingToken: token });
  if (!current) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID);
  if (current.bookingTokenExpiresAt <= now) return bookingFailure(INTERVIEW_ERROR_CODES.BOOKING_TOKEN_EXPIRED);
  return bookingFailure(INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED);
}

/**
 * Guarded reschedule: only a SCHEDULED interview goes back to proposed, with
 * fresh slots and a FRESH booking token + expiry — the old link must stop
 * working, which is why the token is replaced, not reused. calendarSequence is
 * incremented so the CANCEL for the old time supersedes the booked invite.
 * Cross-tenant or wrong-status matches nothing and returns null.
 */
export async function rescheduleInterviewToProposed(companyId, interviewId, proposedSlots, now = new Date()) {
  const companyOid = toOid(companyId);
  const interviewOid = toOid(interviewId);
  if (!companyOid || !interviewOid) return null;
  const collection = await interviewsCol();
  return collection.findOneAndUpdate(
    { _id: interviewOid, companyId: companyOid, status: INTERVIEW_STATUSES.SCHEDULED },
    {
      $set: {
        status: INTERVIEW_STATUSES.PROPOSED,
        proposedSlots: proposedSlots.map((slot) => ({
          startAtUtc: slot.startAtUtc, durationMinutes: slot.durationMinutes,
        })),
        selectedSlotIndex: null,
        startAtUtc: null,
        bookedAt: null,
        bookingToken: generateBookingToken(),
        bookingTokenExpiresAt: new Date(now.getTime() + BOOKING_TOKEN_TTL_DAYS * MILLISECONDS_PER_DAY),
        updatedAt: now,
      },
      $inc: { calendarSequence: 1 },
    },
    { returnDocument: 'after' },
  );
}
