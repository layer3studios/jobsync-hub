// FILE: src/services/interview/interview-feedback-request-service.js
// "Calendar event ended → nudge the interviewer" (the Greenhouse/Lever
// pattern), piggybacked on the reminder sweep. CROSS-TENANT BY NATURE, like
// pool-monitor-service: the sweep scans ended scheduled interviews globally and
// takes companyId from each document. A guarded claim (feedbackRequestSentAt
// null → now) makes concurrent sweeps send at most once per interview.
// Best-effort throughout — this must never fail the sweep.

import { col } from '../../Db/connection.js';
import { INTERVIEW_STATUSES } from '../../models/interview/interview-constants.js';
import { getContactForCompany as defaultGetContact } from '../../models/public/contact-model.js';
import { getEmployerUserById as defaultGetEmployerUserById } from '../../models/employer/employer-user-model.js';
import { sendTransactionalEmail as defaultSendEmail } from '../email/send-email-service.js';
import { renderEmailShell, renderPlainText } from '../email/templates/email-layout-helpers.js';
import { FRONTEND_URL } from '../../env.js';

const SWEEP_BATCH_LIMIT = 50; // per sweep; leftovers ride the next one
const MINUTE_MS = 60000;

export function buildFeedbackRequestEmail({ candidateName, applicantUrl }) {
  const shellInput = {
    previewText: `How did your interview with ${candidateName} go?`,
    headingText: 'How did the interview go?',
    bodyBlocks: [
      `Your interview with ${candidateName} has ended.`,
      'Submit your feedback so you can move forward while the conversation is still fresh.',
      `Open the candidate: ${applicantUrl}`,
    ],
    footerLines: ['Sent by JobMesh.'],
  };
  return {
    subject: `How did your interview with ${candidateName} go?`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

/** Scheduled interviews whose end (start + duration) has passed, un-nudged. */
async function findEndedUnnudgedInterviews(now) {
  return (await col('interviews')).find({
    status: INTERVIEW_STATUSES.SCHEDULED,
    startAtUtc: { $ne: null, $lt: now }, // cheap index-friendly upper bound…
    feedbackRequestSentAt: null,
  }).limit(SWEEP_BATCH_LIMIT).toArray();
}

/** One sweep pass. Returns how many nudges were sent. Never throws. */
export async function sendDueFeedbackRequests(now = new Date(), deps = {}) {
  const {
    getContact = defaultGetContact,
    getEmployerUserById = defaultGetEmployerUserById,
    sendEmail = defaultSendEmail,
  } = deps;
  let sentCount = 0;
  try {
    const candidates = await findEndedUnnudgedInterviews(now);
    // …then the exact end-time check (start + duration < now) in JS.
    const ended = candidates.filter((interview) => {
      const durationMs = (interview.durationMinutes ?? 0) * MINUTE_MS;
      return interview.startAtUtc.getTime() + durationMs < now.getTime();
    });

    const interviews = await col('interviews');
    for (const interview of ended) {
      // Claim BEFORE sending — a concurrent sweep matches nothing and skips.
      const claimed = await interviews.findOneAndUpdate(
        { _id: interview._id, feedbackRequestSentAt: null },
        { $set: { feedbackRequestSentAt: now, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!claimed) continue;

      const [interviewer, contact] = await Promise.all([
        getEmployerUserById(interview.createdByEmployerUserId),
        getContact(interview.companyId, interview.contactId),
      ]);
      if (!interviewer?.email) continue;

      const applicantUrl = `${FRONTEND_URL}/employer/jobs/${interview.postingId}/applicants/${interview.applicationId}`;
      const email = buildFeedbackRequestEmail({
        candidateName: contact?.fullName || 'your candidate',
        applicantUrl,
      });
      const result = await sendEmail({ to: interviewer.email, ...email });
      if (result.sent) sentCount += 1;
    }
  } catch (err) {
    console.warn(`[feedback-request] sweep failed: ${err.message}`);
  }
  return sentCount;
}
