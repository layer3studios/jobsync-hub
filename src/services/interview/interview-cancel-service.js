// FILE: src/services/interview/interview-cancel-service.js
// Employer-side cancellation with candidate + interviewer notice. The model's
// guarded cancel increments calendarSequence, so the METHOD:CANCEL .ics built
// afterwards supersedes the original invite. Emails are best-effort.

import { cancelInterviewForCompany as defaultCancelInterview } from '../../models/interview/interview-model.js';
import { cancelInterviewReminders as defaultCancelReminders } from '../../models/interview/interview-reminder-job-model.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';
import { appendAudit as defaultAppendAudit } from '../dpdp/audit-log-service.js';
import { buildInterviewEmailContext as defaultBuildContext } from './interview-context-helpers.js';
import { sendInterviewCancelledEmails as defaultSendCancelled } from './interview-notification-service.js';

const AUDIT_PURPOSE = 'interview_scheduling';

/** Cancel + audit + notify. Returns the cancelled interview, or null. */
export async function cancelInterviewForCompanyWithNotice(companyId, interviewId, cancelReason, actorEmployerUserId, deps = {}) {
  const {
    cancelInterview = defaultCancelInterview,
    cancelReminders = defaultCancelReminders,
    appendAuditEntry = defaultAppendAudit,
    buildContext = defaultBuildContext,
    sendCancelledEmails = defaultSendCancelled,
  } = deps;

  const interview = await cancelInterview(companyId, interviewId, cancelReason);
  if (!interview) return null;

  // Best-effort: a cancelled interview must never send a reminder.
  try {
    await cancelReminders(interview._id);
  } catch (err) {
    console.warn(`[interview] reminder cancellation failed: ${err.message}`);
  }

  await appendAuditEntry({
    event: AUDIT_EVENTS.INTERVIEW_CANCELLED, actorType: 'employer', actorId: actorEmployerUserId,
    targetType: 'interview', targetId: interview._id, purpose: AUDIT_PURPOSE,
    metadata: { cancelReason: cancelReason ?? null },
  });

  try {
    const context = await buildContext(interview, deps);
    if (context) await sendCancelledEmails(context, deps);
  } catch (err) {
    console.warn(`[interview] cancellation emails failed: ${err.message}`);
  }
  return interview;
}
