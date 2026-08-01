// FILE: src/services/email/rejection-email-service.js
// Candidate-facing rejection emails. Best-effort THROUGHOUT: archiving must
// succeed whether or not the email does, so nothing here ever throws. Template
// choice follows the application's stage: before the Interview stage the brief
// application template; at or past it, the warmer post-interview one.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { getApplicationForCompany as defaultGetApplication } from '../../models/public/application-model.js';
import { getContactForCompany as defaultGetContact } from '../../models/public/contact-model.js';
import { getPostingForCompany as defaultGetPosting } from '../../models/employer/posting-model.js';
import { getCompanyById as defaultGetCompany } from '../../models/employer/company-model.js';
import { listStagesForCompany as defaultListStages } from '../../models/employer/stage-model.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';
import { appendAudit as defaultAppendAudit } from '../dpdp/audit-log-service.js';
import { sendTransactionalEmail as defaultSendEmail } from './send-email-service.js';
import { buildRejectionApplicationEmail } from './templates/rejection-application-template.js';
import { buildRejectionPostInterviewEmail } from './templates/rejection-post-interview-template.js';
import { buildRejectionPositionFilledEmail } from './templates/rejection-position-filled-template.js';

const AUDIT_PURPOSE = 'candidate_communication';
const EMAIL_BATCH_SIZE = 10; // concurrent sends per batch — no N+1, no thundering herd

/** True when the application's stage sits at or past the company's Interview stage. */
async function reachedInterviewStage(companyId, application, listStages) {
  const stages = await listStages(companyId);
  const interviewStage = stages.find((s) => String(s.text ?? '').trim().toLowerCase() === 'interview');
  if (!interviewStage) return false;
  const current = stages.find((s) => s._id.toString() === application.stageId?.toString());
  return current != null && current.order >= interviewStage.order;
}

/**
 * Send the stage-appropriate rejection email for one archived application.
 * Never throws. Returns { sent, skipped? }.
 */
export async function sendRejectionEmail(companyId, applicationId, { reason, skipEmail = false } = {}, deps = {}) {
  if (skipEmail) return { sent: false, skipped: true };
  const {
    getApplication = defaultGetApplication,
    getContact = defaultGetContact,
    getPosting = defaultGetPosting,
    getCompany = defaultGetCompany,
    listStages = defaultListStages,
    sendEmail = defaultSendEmail,
    appendAuditEntry = defaultAppendAudit,
  } = deps;

  try {
    const application = await getApplication(companyId, applicationId);
    if (!application) return { sent: false };
    const [contact, posting, company] = await Promise.all([
      getContact(companyId, application.contactId),
      getPosting(companyId, application.jobId),
      getCompany(companyId),
    ]);
    if (!contact?.email) return { sent: false };

    const merge = {
      candidateName: contact.fullName || 'there',
      jobTitle: posting?.title ?? 'the position',
      companyName: company?.name ?? 'the company',
    };
    const pastInterview = await reachedInterviewStage(companyId, application, listStages);
    const email = pastInterview
      ? buildRejectionPostInterviewEmail(merge)
      : buildRejectionApplicationEmail(merge);

    const result = await sendEmail({ to: contact.email, ...email });
    await appendAuditEntry({
      event: AUDIT_EVENTS.REJECTION_EMAIL_SENT, actorType: 'system', actorId: null,
      targetType: 'application', targetId: application._id, purpose: AUDIT_PURPOSE,
      metadata: { template: pastInterview ? 'post_interview' : 'application', reason: reason ?? null, sent: result.sent },
    });
    return { sent: result.sent };
  } catch (err) {
    console.warn(`[rejection-email] send failed: ${err.message}`);
    return { sent: false };
  }
}

/**
 * Position filled: email every remaining non-terminal, non-archived candidate
 * on the posting except the hired one(s). Batched sends; one failure never
 * blocks the rest. Returns { sent, failed }.
 */
export async function sendPositionFilledEmails(companyId, postingId, { excludeApplicationIds = [] } = {}, deps = {}) {
  const {
    getPosting = defaultGetPosting,
    getCompany = defaultGetCompany,
    listStages = defaultListStages,
    sendEmail = defaultSendEmail,
  } = deps;

  try {
    const companyOid = new ObjectId(String(companyId));
    const posting = await getPosting(companyId, postingId);
    if (!posting) return { sent: 0, failed: 0 };
    const [company, stages] = await Promise.all([getCompany(companyId), listStages(companyId)]);
    const terminalIds = stages.filter((s) => s.isTerminal).map((s) => s._id);
    const excludeOids = excludeApplicationIds
      .map((id) => (ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null))
      .filter(Boolean);

    const applications = await (await col('applications')).find({
      companyId: companyOid, jobId: posting._id, archived: null,
      stageId: { $nin: terminalIds }, _id: { $nin: excludeOids },
    }).project({ contactId: 1 }).toArray();
    if (applications.length === 0) return { sent: 0, failed: 0 };

    // One batched contact load — never per-application.
    const contacts = await (await col('contacts')).find({
      companyId: companyOid, _id: { $in: applications.map((a) => a.contactId).filter(Boolean) },
    }).project({ fullName: 1, email: 1 }).toArray();

    let sent = 0; let failed = 0;
    for (let i = 0; i < contacts.length; i += EMAIL_BATCH_SIZE) {
      const batch = contacts.slice(i, i + EMAIL_BATCH_SIZE).map(async (contact) => {
        try {
          if (!contact.email) { failed += 1; return; }
          const email = buildRejectionPositionFilledEmail({
            candidateName: contact.fullName || 'there',
            jobTitle: posting.title,
            companyName: company?.name ?? 'the company',
          });
          const result = await sendEmail({ to: contact.email, ...email });
          if (result.sent) sent += 1; else failed += 1;
        } catch {
          failed += 1; // a THROWN send counts as failed, same as a resolved failure
        }
      });
      // One failed send never blocks the rest of the batch.
      await Promise.all(batch);
    }
    return { sent, failed };
  } catch (err) {
    console.warn(`[rejection-email] position-filled sweep failed: ${err.message}`);
    return { sent: 0, failed: 0 };
  }
}
