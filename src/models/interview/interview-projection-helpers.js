// FILE: src/models/interview/interview-projection-helpers.js
// Client-safe projections for interview docs, split out of interview-model.js
// (file-size rule). Two audiences with very different trust levels — see each
// function's contract.

import { INTERVIEW_MODES } from './interview-constants.js';

/** Client-safe projection for the EMPLOYER. Never includes bookingToken. */
export function toPublicInterview(doc) {
  return {
    id: doc._id.toString(),
    applicationId: doc.applicationId?.toString() ?? null,
    postingId: doc.postingId?.toString() ?? null,
    contactId: doc.contactId?.toString() ?? null,
    status: doc.status,
    proposedSlots: doc.proposedSlots,
    selectedSlotIndex: doc.selectedSlotIndex,
    startAtUtc: doc.startAtUtc,
    timezoneId: doc.timezoneId,
    durationMinutes: doc.durationMinutes,
    mode: doc.mode,
    meetingUrl: doc.meetingUrl,
    locationText: doc.locationText,
    calendarSequence: doc.calendarSequence,
    interviewerEmployerUserIds: (doc.interviewerEmployerUserIds ?? []).map((id) => id.toString()),
    createdByEmployerUserId: doc.createdByEmployerUserId?.toString() ?? null,
    bookingTokenExpiresAt: doc.bookingTokenExpiresAt,
    bookedAt: doc.bookedAt,
    cancelledAt: doc.cancelledAt,
    cancelReason: doc.cancelReason,
    createdAt: doc.createdAt,
  };
}

/**
 * Projection for the UNAUTHENTICATED CANDIDATE booking page. Exposes ONLY what
 * the picker needs. MUST NOT include companyId, applicationId, contactId,
 * interviewerEmployerUserIds, calendarUid, bookingToken, or any internal id
 * beyond the interview's own — getting this wrong leaks tenant data to an
 * unauthenticated endpoint. Posting/company display names are resolved by the
 * service layer, never from ids exposed here.
 */
export function toCandidateInterview(doc) {
  return {
    // Both already reach the candidate via email, so exposing them leaks
    // nothing new: the expiry lets the booking page state a real date, and the
    // cancel reason lets the cancelled state say why.
    bookingTokenExpiresAt: doc.bookingTokenExpiresAt,
    cancelReason: doc.cancelReason ?? null,
    // A candidate cannot choose an in-person slot without knowing where to
    // travel, so locationText is exposed for that mode only. meetingUrl stays
    // hidden until the confirmation email — a pre-booking link invites gatecrashing.
    locationText: doc.mode === INTERVIEW_MODES.IN_PERSON ? doc.locationText : null,
    id: doc._id.toString(),
    status: doc.status,
    proposedSlots: doc.proposedSlots.map((slot) => ({
      startAtUtc: slot.startAtUtc, durationMinutes: slot.durationMinutes,
    })),
    selectedSlotIndex: doc.selectedSlotIndex,
    startAtUtc: doc.startAtUtc,
    timezoneId: doc.timezoneId,
    durationMinutes: doc.durationMinutes,
    mode: doc.mode,
  };
}
