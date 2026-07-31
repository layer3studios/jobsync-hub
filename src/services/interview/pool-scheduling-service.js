// FILE: src/services/interview/pool-scheduling-service.js
// One-click pool scheduling: the employer sends a link, the candidate picks
// from the posting's interview_times pool. Produces the SAME interview document
// as the manual flow, with source 'pool' and an empty proposedSlots — the
// booking page queries the pool live instead.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany as defaultGetApplication } from '../../models/public/application-model.js';
import { getPostingForCompany as defaultGetPosting } from '../../models/employer/posting-model.js';
import {
  createInterviewForCompany, listInterviewsForApplication,
  INTERVIEW_STATUSES, INTERVIEW_ERROR_CODES,
} from '../../models/interview/index.js';
import { countAvailableTimesForPosting as defaultCountAvailable } from '../../models/interview/interview-time-model.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';
import { appendAudit as defaultAppendAudit } from '../dpdp/audit-log-service.js';
import { buildInterviewEmailContext as defaultBuildContext } from './interview-context-helpers.js';
import { sendInterviewInvitationEmail as defaultSendInvitation } from './interview-notification-service.js';

const ACTIVE_STATUSES = [INTERVIEW_STATUSES.PROPOSED, INTERVIEW_STATUSES.SCHEDULED];
const AUDIT_PURPOSE = 'interview_scheduling';
export const INTERVIEW_SOURCE_POOL = 'pool';

export async function sendPoolSchedulingLink(companyId, applicationId, actorEmployerUserId, deps = {}) {
  const {
    getApplication = defaultGetApplication,
    getPosting = defaultGetPosting,
    countAvailable = defaultCountAvailable,
    appendAuditEntry = defaultAppendAudit,
    buildContext = defaultBuildContext,
    sendInvitationEmail = defaultSendInvitation,
  } = deps;

  const application = await getApplication(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');

  const posting = await getPosting(companyId, application.jobId);
  if (!posting) throw new HttpError(404, 'Posting not found', 'POSTING_NOT_FOUND');
  if (!posting.interviewDefaults) {
    throw new HttpError(400, 'Set up interview defaults on the posting settings before sending.', INTERVIEW_ERROR_CODES.NO_INTERVIEW_DEFAULTS);
  }

  const availableCount = await countAvailable(companyId, posting._id);
  if (availableCount === 0) {
    throw new HttpError(400, 'No available times — add more on the posting settings.', INTERVIEW_ERROR_CODES.POOL_EMPTY);
  }

  const existing = await listInterviewsForApplication(companyId, applicationId);
  if (existing.some((interview) => ACTIVE_STATUSES.includes(interview.status))) {
    throw new HttpError(409, 'An interview is already proposed or scheduled for this application', INTERVIEW_ERROR_CODES.INTERVIEW_ALREADY_ACTIVE);
  }

  const defaults = posting.interviewDefaults;
  const interview = await createInterviewForCompany(companyId, {
    applicationId,
    postingId: posting._id,
    contactId: application.contactId,
    source: INTERVIEW_SOURCE_POOL,
    proposedSlots: [], // the candidate picks from the live pool, not pre-set slots
    timezoneId: defaults.timezoneId,
    durationMinutes: defaults.durationMinutes,
    mode: defaults.mode,
    meetingUrl: defaults.meetingUrl,
    locationText: defaults.locationText,
    interviewerEmployerUserIds: [],
  }, actorEmployerUserId);

  await appendAuditEntry({
    event: AUDIT_EVENTS.INTERVIEW_PROPOSED, actorType: 'employer', actorId: actorEmployerUserId,
    targetType: 'interview', targetId: interview._id, purpose: AUDIT_PURPOSE,
    metadata: { mode: interview.mode, source: INTERVIEW_SOURCE_POOL, availableCount },
  });

  try {
    const context = await buildContext(interview, deps);
    if (context) await sendInvitationEmail(context, deps);
  } catch (err) {
    console.warn(`[interview] pool invitation email failed: ${err.message}`);
  }
  return interview;
}
