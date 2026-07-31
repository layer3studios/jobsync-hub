// FILE: src/services/interview/interview-scheduling-service.js
// Employer-side propose + reschedule. Every function is companyId-scoped.
// Scheduling an interview is a new processing activity on candidate personal
// data, so both paths write a DPDP audit entry. Emails are best-effort: the
// interview exists (or is rescheduled) regardless of email outcome.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany as defaultGetApplication } from '../../models/public/application-model.js';
import {
  createInterviewForCompany, getInterviewForCompany, listInterviewsForApplication,
  rescheduleInterviewToProposed, INTERVIEW_STATUSES, INTERVIEW_ERROR_CODES,
  validateProposedSlots, validateInterviewMode, validateDurationMinutes, validateMeetingLocation,
} from '../../models/interview/index.js';
import { cancelInterviewReminders as defaultCancelReminders } from '../../models/interview/interview-reminder-job-model.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';
import { appendAudit as defaultAppendAudit } from '../dpdp/audit-log-service.js';
import { buildInterviewEmailContext as defaultBuildContext } from './interview-context-helpers.js';
import {
  sendInterviewInvitationEmail as defaultSendInvitation,
  sendInterviewCancelledEmails as defaultSendCancelled,
} from './interview-notification-service.js';

const ACTIVE_STATUSES = [INTERVIEW_STATUSES.PROPOSED, INTERVIEW_STATUSES.SCHEDULED];
const AUDIT_PURPOSE = 'interview_scheduling';

/** Best-effort email fire: the interview state change already happened. */
async function fireEmail(label, emailPromise) {
  try {
    await emailPromise;
  } catch (err) {
    console.warn(`[interview] ${label} email failed: ${err.message}`);
  }
}

export async function proposeInterviewForCompany(companyId, applicationId, input, actorEmployerUserId, deps = {}) {
  const {
    getApplication = defaultGetApplication,
    appendAuditEntry = defaultAppendAudit,
    buildContext = defaultBuildContext,
    sendInvitationEmail = defaultSendInvitation,
  } = deps;

  const application = await getApplication(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');

  validateProposedSlots(input.proposedSlots);
  validateInterviewMode(input.mode);
  validateDurationMinutes(input.durationMinutes);
  const { meetingUrl, locationText } = validateMeetingLocation(input.mode, input.meetingUrl, input.locationText);

  const existing = await listInterviewsForApplication(companyId, applicationId);
  if (existing.some((interview) => ACTIVE_STATUSES.includes(interview.status))) {
    throw new HttpError(409, 'An interview is already proposed or scheduled for this application', INTERVIEW_ERROR_CODES.INTERVIEW_ALREADY_ACTIVE);
  }

  const interview = await createInterviewForCompany(companyId, {
    applicationId,
    postingId: application.jobId,
    contactId: application.contactId,
    proposedSlots: input.proposedSlots,
    timezoneId: input.timezoneId,
    durationMinutes: input.durationMinutes,
    mode: input.mode,
    meetingUrl,
    locationText,
    interviewerEmployerUserIds: input.interviewerEmployerUserIds ?? [],
  }, actorEmployerUserId);

  // Related records (posting/contact/company) must exist for the context; a
  // missing one means we can notify nobody, but the interview still stands.
  const context = await buildContext(interview, deps);

  await appendAuditEntry({
    event: AUDIT_EVENTS.INTERVIEW_PROPOSED, actorType: 'employer', actorId: actorEmployerUserId,
    targetType: 'interview', targetId: interview._id, purpose: AUDIT_PURPOSE,
    metadata: { mode: interview.mode, slotCount: interview.proposedSlots.length },
  });

  if (context) await fireEmail('invitation', sendInvitationEmail(context, deps));
  return interview;
}

/**
 * Reschedule a SCHEDULED interview: cancel the old time (METHOD:CANCEL), reset
 * to proposed with fresh slots and a FRESH booking token — the old link must
 * stop working — then invite the candidate to pick again.
 */
export async function rescheduleInterviewForCompany(companyId, interviewId, newSlots, actorEmployerUserId, deps = {}) {
  const {
    appendAuditEntry = defaultAppendAudit,
    buildContext = defaultBuildContext,
    sendInvitationEmail = defaultSendInvitation,
    sendCancelledEmails = defaultSendCancelled,
    cancelReminders = defaultCancelReminders,
  } = deps;

  validateProposedSlots(newSlots);

  const previous = await getInterviewForCompany(companyId, interviewId);
  if (!previous) throw new HttpError(404, 'Interview not found', INTERVIEW_ERROR_CODES.INTERVIEW_NOT_FOUND);
  if (previous.status !== INTERVIEW_STATUSES.SCHEDULED) {
    throw new HttpError(409, 'Only a scheduled interview can be rescheduled', INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED);
  }

  const interview = await rescheduleInterviewToProposed(companyId, interviewId, newSlots);
  if (!interview) throw new HttpError(409, 'Interview changed state during reschedule', INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED);

  // Best-effort: the old booked time no longer exists, so its reminders must
  // die. Fresh ones are scheduled only when the candidate rebooks.
  try {
    await cancelReminders(interview._id);
  } catch (err) {
    console.warn(`[interview] reminder cancellation failed: ${err.message}`);
  }

  await appendAuditEntry({
    event: AUDIT_EVENTS.INTERVIEW_RESCHEDULED, actorType: 'employer', actorId: actorEmployerUserId,
    targetType: 'interview', targetId: interview._id, purpose: AUDIT_PURPOSE,
    metadata: { previousStartAtUtc: previous.startAtUtc, slotCount: interview.proposedSlots.length },
  });

  const context = await buildContext(interview, deps);
  if (context) {
    // CANCEL for the OLD booked time, with the already-incremented sequence.
    await fireEmail('reschedule-cancel', sendCancelledEmails(
      { ...context, cancelledStartAtUtc: previous.startAtUtc, cancelReason: 'Rescheduled — new times proposed' },
      deps,
    ));
    await fireEmail('reschedule-invitation', sendInvitationEmail(context, deps));
  }
  return interview;
}
