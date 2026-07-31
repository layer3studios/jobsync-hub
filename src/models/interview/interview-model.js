// FILE: src/models/interview/interview-model.js
// interviews collection — proposed/booked interview slots per application.
// Every query is companyId-scoped except findInterviewByBookingToken (the
// candidate is unauthenticated; see that function). Atomic slot booking lives
// in interview-booking-model.js.
//
// WHY calendarUid AND calendarSequence LIVE HERE: a reschedule must reuse the
// SAME UID with an incremented SEQUENCE, or the candidate's calendar creates a
// duplicate event instead of moving the existing one. Regenerating the UID per
// email is the single most common failure in this feature — so the UID is
// generated ONCE at insert and is immutable for the life of the interview, and
// every state change that re-emails an invite increments calendarSequence.

import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import {
  INTERVIEW_STATUSES, BOOKING_TOKEN_BYTE_LENGTH, BOOKING_TOKEN_TTL_DAYS,
} from './interview-constants.js';
import { DEFAULT_INTERVIEW_TIMEZONE } from '../../services/email/calendar-invite-constants.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const interviewsCol = () => col('interviews');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Stable for the life of the interview — never regenerated (see header). */
function generateCalendarUid() {
  return `interview-${crypto.randomUUID()}@jobmesh.in`;
}

/** URL-safe 43-char (256-bit) token, mirroring generateInviteTokenUrlSafe.
 *  Exported for the reschedule path, which must mint a FRESH token. */
export function generateBookingToken() {
  return crypto.randomBytes(BOOKING_TOKEN_BYTE_LENGTH).toString('base64url');
}

/** Idempotent index setup. Called on boot. */
export async function ensureInterviewIndexes() {
  const collection = await interviewsCol();
  await collection.createIndex({ bookingToken: 1 }, { unique: true, name: 'interviews_bookingToken' });
  await collection.createIndex({ companyId: 1, applicationId: 1 }, { name: 'interviews_companyId_applicationId' });
  await collection.createIndex({ companyId: 1, status: 1, startAtUtc: 1 }, { name: 'interviews_companyId_status_startAtUtc' });
  // For the chunk 5 reminder sweep — sparse: only booked interviews have startAtUtc.
  await collection.createIndex({ startAtUtc: 1 }, { sparse: true, name: 'interviews_startAtUtc' });
}

/** Insert a proposed interview. Generates calendarUid + bookingToken. */
export async function createInterviewForCompany(companyId, input, createdByEmployerUserId) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('createInterviewForCompany: invalid companyId');
  const now = new Date();
  const doc = {
    companyId: companyOid,
    applicationId: toOid(input.applicationId),
    postingId: toOid(input.postingId),
    contactId: toOid(input.contactId),
    status: INTERVIEW_STATUSES.PROPOSED,
    proposedSlots: input.proposedSlots.map((slot) => ({
      startAtUtc: slot.startAtUtc, durationMinutes: slot.durationMinutes,
    })),
    selectedSlotIndex: null,
    startAtUtc: null,
    timezoneId: input.timezoneId || DEFAULT_INTERVIEW_TIMEZONE,
    durationMinutes: input.durationMinutes,
    mode: input.mode,
    meetingUrl: input.meetingUrl ?? null,
    locationText: input.locationText ?? null,
    calendarUid: generateCalendarUid(),
    calendarSequence: 0,
    interviewerEmployerUserIds: (input.interviewerEmployerUserIds ?? []).map(toOid).filter(Boolean),
    createdByEmployerUserId: toOid(createdByEmployerUserId),
    bookingToken: generateBookingToken(),
    bookingTokenExpiresAt: new Date(now.getTime() + BOOKING_TOKEN_TTL_DAYS * MILLISECONDS_PER_DAY),
    googleCalendarEventId: null, // reserved for the phase-2 Google adapter
    bookedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const collection = await interviewsCol();
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** One interview, scoped to the company. Cross-tenant returns null. */
export async function getInterviewForCompany(companyId, interviewId) {
  const companyOid = toOid(companyId);
  const interviewOid = toOid(interviewId);
  if (!companyOid || !interviewOid) return null;
  return (await interviewsCol()).findOne({ _id: interviewOid, companyId: companyOid });
}

/** All interviews for one application, scoped to the company. Newest first. */
export async function listInterviewsForApplication(companyId, applicationId) {
  const companyOid = toOid(companyId);
  const applicationOid = toOid(applicationId);
  if (!companyOid || !applicationOid) return [];
  return (await interviewsCol())
    .find({ companyId: companyOid, applicationId: applicationOid })
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Look up an interview by its booking token. INTENTIONALLY GLOBAL — the
 * candidate is unauthenticated and has no company context; the 256-bit token IS
 * the credential, and the service layer owns any further scoping. This mirrors
 * findCompanyInviteByToken and is the only unscoped read in this model.
 */
export async function findInterviewByBookingToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return (await interviewsCol()).findOne({ bookingToken: token });
}

/**
 * Cancel a proposed or scheduled interview. Guarded findOneAndUpdate — any other
 * status (or a cross-tenant id) matches nothing and returns null. Increments
 * calendarSequence so the METHOD:CANCEL email supersedes the original invite.
 */
export async function cancelInterviewForCompany(companyId, interviewId, cancelReason) {
  const companyOid = toOid(companyId);
  const interviewOid = toOid(interviewId);
  if (!companyOid || !interviewOid) return null;
  const now = new Date();
  return (await interviewsCol()).findOneAndUpdate(
    {
      _id: interviewOid,
      companyId: companyOid,
      status: { $in: [INTERVIEW_STATUSES.PROPOSED, INTERVIEW_STATUSES.SCHEDULED] },
    },
    {
      $set: {
        status: INTERVIEW_STATUSES.CANCELLED,
        cancelReason: cancelReason ?? null,
        cancelledAt: now,
        updatedAt: now,
      },
      $inc: { calendarSequence: 1 },
    },
    { returnDocument: 'after' },
  );
}
