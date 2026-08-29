// FILE: src/services/admin/ai-alert-service.js
// Watches today's AI spend and emails the admins when a threshold is crossed.
//
// NEVER THROWS: this runs on a cron, and an alerting failure must not take a
// timer down. Every exit resolves to a { sent, reason } shape.
//
// The 12h cooldown is the point of the feature. A budget breach persists for
// the rest of the day, so an uncooled check would email every 30 minutes until
// midnight — which trains people to ignore the alert.

import { listUsageStats, istDateString } from '../../gemma/usage-stats.js';
import { getAlertSettings, markAlertSent } from '../../models/admin/alert-settings-model.js';
import { sendTransactionalEmail } from '../../services/email/send-email-service.js';

const COOLDOWN_MS = 12 * 60 * 60 * 1000;

const sumErrors = (errors) => Object.values(errors ?? {}).reduce((total, n) => total + (n ?? 0), 0);

/** Fold today's rows into the two numbers the thresholds are about. */
export function summariseToday(docs = [], today) {
  let tokens = 0;
  let requests = 0;
  let errors = 0;
  for (const doc of docs) {
    if (today && doc.date !== today) continue;
    tokens += doc.tokensEstimated ?? 0;
    requests += doc.requests ?? 0;
    errors += sumErrors(doc.errors);
  }
  const errorRatePct = requests > 0 ? Math.round((errors / requests) * 1000) / 10 : 0;
  return { tokens, requests, errors, errorRatePct };
}

/** Which thresholds today's numbers cross, if any. */
export function breachesFor(summary, settings) {
  const breaches = [];
  if (summary.tokens >= settings.dailyTokenThreshold) {
    breaches.push(`Token spend ${summary.tokens.toLocaleString()} has reached the daily threshold of ${settings.dailyTokenThreshold.toLocaleString()}.`);
  }
  // An error rate over a handful of requests is noise, not a signal.
  if (summary.requests >= 20 && summary.errorRatePct >= settings.errorRateThresholdPct) {
    breaches.push(`Error rate ${summary.errorRatePct}% has reached the threshold of ${settings.errorRateThresholdPct}% (${summary.errors} of ${summary.requests} calls).`);
  }
  return breaches;
}

function buildEmail(summary, breaches, today) {
  const lines = [
    `AI usage alert for ${today} (IST).`,
    '',
    ...breaches.map((breach) => `- ${breach}`),
    '',
    `Requests today: ${summary.requests.toLocaleString()}`,
    `Tokens today:   ${summary.tokens.toLocaleString()}`,
    `Errors today:   ${summary.errors.toLocaleString()} (${summary.errorRatePct}%)`,
    '',
    'No further alert will be sent for 12 hours.',
  ];
  const text = lines.join('\n');
  return {
    subject: `[JobMesh] AI usage alert — ${today}`,
    text,
    html: `<pre style="font:14px/1.5 ui-monospace,monospace">${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`,
  };
}

/**
 * One check cycle. Resolves to { sent, reason } and never rejects.
 * Deps are injectable so tests need neither usage data nor a mail server.
 */
export async function checkAndAlert(deps = {}) {
  const {
    getSettings = getAlertSettings,
    listStats = listUsageStats,
    sendEmail = sendTransactionalEmail,
    markSent = markAlertSent,
    now = new Date(),
  } = deps;

  try {
    const settings = await getSettings();
    if (!settings.alertsEnabled) return { sent: false, reason: 'alerts_disabled' };
    if (settings.alertEmails.length === 0) return { sent: false, reason: 'no_recipients' };

    if (settings.lastAlertSentAt) {
      const since = now.getTime() - new Date(settings.lastAlertSentAt).getTime();
      if (since < COOLDOWN_MS) return { sent: false, reason: 'cooldown' };
    }

    const today = istDateString(now);
    const summary = summariseToday(await listStats(1, now), today);
    const breaches = breachesFor(summary, settings);
    if (breaches.length === 0) return { sent: false, reason: 'below_thresholds', summary };

    const email = buildEmail(summary, breaches, today);
    await sendEmail({ to: settings.alertEmails.join(', '), ...email });
    await markSent(now);
    return { sent: true, breaches, summary };
  } catch (err) {
    // A cron must never die on a bad check.
    console.warn(`[ai-alert] check failed: ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}

export default checkAndAlert;
