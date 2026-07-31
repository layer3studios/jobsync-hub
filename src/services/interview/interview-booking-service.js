// FILE: src/services/interview/interview-booking-service.js
// Unauthenticated candidate path — the 256-bit booking token is the credential.
// The model's bookInterviewSlot is the atomic double-booking guard; this layer
// never re-implements it. All related records are loaded using the interview's
// OWN companyId, never a caller-supplied value. Pool bookings (source 'pool')
// live in interview-pool-booking-service.js and share runPostBookingSideEffects.

import { bookInterviewSlot as defaultBookSlot } from '../../models/interview/interview-booking-model.js';
import { findInterviewByBookingToken as defaultFindByToken } from '../../models/interview/interview-model.js';
import { toCandidateInterview } from '../../models/interview/interview-projection-helpers.js';
import { INTERVIEW_STATUSES } from '../../models/interview/interview-constants.js';
import { listAvailableTimesForPublicBooking as defaultListPoolTimes } from '../../models/interview/interview-time-booking-model.js';
import { getCompanyById as defaultGetCompanyById } from '../../models/employer/company-model.js';
import { getPostingForCompany as defaultGetPostingForCompany } from '../../models/employer/posting-model.js';
import { scheduleInterviewReminders as defaultScheduleReminders } from '../../models/interview/interview-reminder-job-model.js';
import { buildInterviewEmailContext as defaultBuildContext } from './interview-context-helpers.js';
import { sendInterviewConfirmationEmails as defaultSendConfirmations } from './interview-notification-service.js';
import { advanceApplicationToInterviewStage as defaultAdvanceStage } from './interview-stage-advance-service.js';

export const INTERVIEW_SOURCE_POOL = 'pool';

/**
 * Everything that follows a successful booking, identical for both flows:
 * stage auto-advance, 24h reminders, confirmation emails + .ics. Each is
 * best-effort — the booking already happened and stands either way. companyId
 * comes from the booked interview itself, never the caller.
 */
export async function runPostBookingSideEffects(interview, deps = {}) {
  const {
    buildContext = defaultBuildContext,
    sendConfirmationEmails = defaultSendConfirmations,
    advanceStage = defaultAdvanceStage,
    scheduleReminders = defaultScheduleReminders,
  } = deps;
  try {
    await advanceStage(interview.companyId, interview.applicationId, deps);
  } catch (err) {
    console.warn(`[interview] stage auto-advance failed: ${err.message}`);
  }
  try {
    await scheduleReminders(interview);
  } catch (err) {
    console.warn(`[interview] reminder scheduling failed: ${err.message}`);
  }
  try {
    const context = await buildContext(interview, deps);
    if (context) await sendConfirmationEmails(context, deps);
    else console.warn('[interview] booking confirmed but related records missing — no emails sent');
  } catch (err) {
    console.warn(`[interview] confirmation emails failed: ${err.message}`);
  }
}

/**
 * Per-candidate (manual-slot) booking. Returns the model's result shape
 * unchanged on failure; on success runs the shared side effects and returns
 * { booked: true, interview }.
 */
export async function bookInterviewByToken(token, slotIndex, deps = {}) {
  const { bookSlot = defaultBookSlot } = deps;
  const result = await bookSlot(token, slotIndex);
  if (!result.booked) return result;
  await runPostBookingSideEffects(result.interview, deps);
  return { booked: true, interview: result.interview };
}

/**
 * Data for the public booking page. Returns null for an unknown token and
 * { expired: true, companyName } for an expired one. Pool interviews
 * additionally carry a live `times` array (id/startAtUtc/durationMinutes/
 * timezoneId only); per-candidate interviews expose proposedSlots as before.
 */
export async function getBookingPageDataByToken(token, deps = {}) {
  const {
    findByToken = defaultFindByToken,
    getCompanyById = defaultGetCompanyById,
    getPostingForCompany = defaultGetPostingForCompany,
    listPoolTimes = defaultListPoolTimes,
  } = deps;

  const interview = await findByToken(token);
  if (!interview) return null;
  if (interview.status === INTERVIEW_STATUSES.PROPOSED && interview.bookingTokenExpiresAt <= new Date()) {
    // The company name (and ONLY the name) rides along so the expired page can
    // tell the candidate who to contact. No posting title, no ids.
    const company = await getCompanyById(interview.companyId);
    return { expired: true, companyName: company?.name ?? null };
  }

  const [company, posting] = await Promise.all([
    getCompanyById(interview.companyId),
    getPostingForCompany(interview.companyId, interview.postingId),
  ]);

  const pageData = {
    ...toCandidateInterview(interview),
    companyName: company?.name ?? null,
    postingTitle: posting?.title ?? null,
    companyLogoUrl: company?.logoUrl ?? null,
  };
  if (interview.source === INTERVIEW_SOURCE_POOL && interview.status === INTERVIEW_STATUSES.PROPOSED) {
    pageData.times = await listPoolTimes(interview.postingId);
  }
  return pageData;
}
