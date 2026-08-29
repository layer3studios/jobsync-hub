// FILE: src/services/admin/weekly-digest-service.js
// Monday-morning summary for the admins. Every number comes from Feature 3's
// mission-control-service and Feature 2's queue rollup — imported, never
// re-derived, so the digest and the dashboards can never disagree.
//
// NEVER THROWS: it runs on a cron. Every exit resolves to { sent, reason }.

import { getOverview, getSystemStatus } from './mission-control-service.js';
import { getCorpusQuality } from './scraper-health-service.js';
import { getAlertSettings } from '../../models/admin/alert-settings-model.js';
import { sendTransactionalEmail } from '../../services/email/send-email-service.js';

/** "+4" / "-5" / "0" — direction stated by the sign, spelled out in the line. */
function movement(delta) {
  if (delta > 0) return `up ${delta}`;
  if (delta < 0) return `down ${Math.abs(delta)}`;
  return 'flat';
}

function line(label, week) {
  return `${label.padEnd(16)} ${String(week.thisWeek).padStart(6)}   (last week ${week.prevWeek}, ${movement(week.delta)})`;
}

const escapeHtml = (value) => value.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** Compose the digest body from already-fetched pieces. Pure, so it is testable. */
export function buildDigest({ overview, status, corpus, now = new Date() }) {
  const dateLabel = now.toISOString().slice(0, 10);
  const failedQueues = (status?.queues ?? []).filter((queue) => queue.failedCount > 0);
  const scraperLine = status?.scraperLastSuccessAt
    ? new Date(status.scraperLastSuccessAt).toISOString().replace('T', ' ').slice(0, 16)
    : 'never';

  const lines = [
    `JobMesh weekly digest — week ending ${dateLabel}`,
    '',
    'THIS WEEK vs LAST WEEK',
    line('New seekers', overview.newSeekers),
    line('Applications', overview.newApplications),
    line('New postings', overview.newPostings),
    '',
    'PLATFORM',
    `Seekers:        ${overview.totals.seekers.toLocaleString()}`,
    `Companies:      ${overview.totals.companies.toLocaleString()}`,
    `Live postings:  ${overview.totals.livePostings.toLocaleString()}`,
    `Scraped jobs:   ${overview.totals.scrapedJobs.toLocaleString()}`,
    '',
    'SYSTEM',
    `Scraper last success: ${scraperLine}`,
    failedQueues.length === 0
      ? 'Queues: no failed jobs'
      : `Queues: ${failedQueues.map((queue) => `${queue.label} ${queue.failedCount} failed`).join('; ')}`,
    corpus
      ? `Corpus quality: ${corpus.pctCleaned}% cleaned, ${corpus.pctTagged}% tagged, ${corpus.duplicateJobIds} duplicate job ids`
      : 'Corpus quality: unavailable',
  ];

  const text = lines.join('\n');
  return {
    subject: `[JobMesh] Weekly digest — ${dateLabel}`,
    text,
    html: `<pre style="font:14px/1.5 ui-monospace,monospace">${escapeHtml(text)}</pre>`,
  };
}

/**
 * Build and send the digest. Resolves to { sent, reason } and never rejects.
 * Deps are injectable so tests need neither a database nor a mail server.
 */
export async function sendWeeklyDigest(deps = {}) {
  const {
    getSettings = getAlertSettings,
    overviewFn = getOverview,
    statusFn = getSystemStatus,
    corpusFn = getCorpusQuality,
    sendEmail = sendTransactionalEmail,
    now = new Date(),
  } = deps;

  try {
    const settings = await getSettings();
    if (settings.alertEmails.length === 0) {
      console.log('[weekly-digest] no alert recipients configured — skipping');
      return { sent: false, reason: 'no_recipients' };
    }

    // The status strip and corpus are nice-to-have; the digest still goes out
    // with the headline numbers if either read fails.
    const [overview, status, corpus] = await Promise.all([
      overviewFn(now),
      statusFn().catch(() => null),
      corpusFn().catch(() => null),
    ]);

    const email = buildDigest({ overview, status, corpus, now });
    await sendEmail({ to: settings.alertEmails.join(', '), ...email });
    return { sent: true, recipients: settings.alertEmails.length };
  } catch (err) {
    console.warn(`[weekly-digest] send failed: ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}

export default sendWeeklyDigest;
