// FILE: src/services/interview/pool-monitor-service.js
// Pool-low watchdog, piggybacked on the reminder sweep: postings whose pool has
// 0 or 1 available future times get a one-time heads-up email to the company
// founder. Deduplicated via postings.lastPoolLowNotifiedAt (once per 24h).
// Best-effort throughout — this must never fail the sweep.

import { interviewTimesCol, INTERVIEW_TIME_STATUSES } from '../../models/interview/interview-time-model.js';
import { col } from '../../Db/connection.js';
import { getCompanyById as defaultGetCompanyById } from '../../models/employer/company-model.js';
import { getEmployerUserById as defaultGetEmployerUserById } from '../../models/employer/employer-user-model.js';
import { sendTransactionalEmail as defaultSendEmail } from '../email/send-email-service.js';
import { renderEmailShell, renderPlainText } from '../email/templates/email-layout-helpers.js';

const NOTIFY_COOLDOWN_MILLISECONDS = 24 * 60 * 60 * 1000;
const LOW_POOL_THRESHOLD = 1;

/** Postings whose pool exists but has ≤1 available future time. */
async function findLowPools(now) {
  return (await interviewTimesCol()).aggregate([
    // Any time doc keeps the posting visible even at 0 available (TTL reaps
    // cancelled/past after 30 days, after which a dead pool goes quiet).
    { $group: {
      _id: { postingId: '$postingId', companyId: '$companyId' },
      availableCount: { $sum: { $cond: [{ $and: [
        { $eq: ['$status', INTERVIEW_TIME_STATUSES.AVAILABLE] },
        { $gt: ['$startAtUtc', now] },
      ] }, 1, 0] } },
    } },
    { $match: { availableCount: { $lte: LOW_POOL_THRESHOLD } } },
  ]).toArray();
}

function buildLowPoolEmail(postingTitle, availableCount) {
  const shellInput = {
    previewText: `Interview pool low for ${postingTitle}`,
    headingText: 'Your interview pool is running low',
    bodyBlocks: [
      `Your interview pool for ${postingTitle} has ${availableCount} time${availableCount === 1 ? '' : 's'} remaining.`,
      'Candidates with a scheduling link may find nothing to book. Add more times on the posting settings.',
    ],
    footerLines: ['Sent by JobMesh.'],
  };
  return {
    subject: `Interview pool low: ${postingTitle}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

/** One sweep pass. Returns how many notifications were sent. Never throws. */
export async function checkPoolLevelsAndNotify(now = new Date(), deps = {}) {
  const {
    getCompanyById = defaultGetCompanyById,
    getEmployerUserById = defaultGetEmployerUserById,
    sendEmail = defaultSendEmail,
  } = deps;
  let notifiedCount = 0;
  try {
    const lowPools = await findLowPools(now);
    if (lowPools.length === 0) return 0;
    const postingsCollection = await col('jobs');
    const cooldownCutoff = new Date(now.getTime() - NOTIFY_COOLDOWN_MILLISECONDS);

    for (const pool of lowPools) {
      const posting = await postingsCollection.findOne({ _id: pool._id.postingId, companyId: pool._id.companyId });
      if (!posting || posting.status !== 'active' || !posting.interviewDefaults) continue;
      if (posting.lastPoolLowNotifiedAt && posting.lastPoolLowNotifiedAt > cooldownCutoff) continue;

      const company = await getCompanyById(pool._id.companyId);
      const founder = company?.claimedByEmployerUserId ? await getEmployerUserById(company.claimedByEmployerUserId) : null;
      if (!founder?.email) continue;

      const { subject, html, text } = buildLowPoolEmail(posting.title, pool.availableCount);
      const result = await sendEmail({ to: founder.email, subject, html, text });
      await postingsCollection.updateOne({ _id: posting._id }, { $set: { lastPoolLowNotifiedAt: now } });
      if (result.sent) notifiedCount += 1;
    }
  } catch (err) {
    console.warn(`[pool-monitor] check failed: ${err.message}`);
  }
  return notifiedCount;
}
