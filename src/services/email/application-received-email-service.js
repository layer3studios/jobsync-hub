// FILE: src/services/email/application-received-email-service.js
// Confirmation email fired the moment an application is stored. Best-effort
// THROUGHOUT: by the time this runs the application is already committed, so
// nothing here may throw or block — a Resend outage must cost the candidate a
// confirmation email, never their application.
//
// Unlike rejection-email-service this takes the merge fields directly rather than
// re-reading them: the apply flow already holds the contact, posting and company it
// just wrote, so a lookup here would be three redundant queries on the hot path.

import { sendTransactionalEmail as defaultSendEmail } from './send-email-service.js';
import { buildApplicationReceivedEmail } from './templates/application-received-template.js';

/**
 * Send one confirmation. Never throws and never rejects — safe to call without
 * awaiting. Returns { sent, skipped? }.
 */
export async function sendApplicationReceivedEmail(
  { to, firstName, postingTitle, companyName },
  deps = {},
) {
  const { sendEmail = defaultSendEmail } = deps;
  // No address means nothing to send to. The apply form requires one, so this is a
  // guard against a malformed record rather than an expected branch.
  if (typeof to !== 'string' || !to.includes('@')) return { sent: false, skipped: true };

  try {
    const email = buildApplicationReceivedEmail({
      firstName: firstName || 'there',
      postingTitle: postingTitle || 'the position',
      companyName: companyName || 'the company',
    });
    const result = await sendEmail({ to, ...email });
    return { sent: result.sent };
  } catch (err) {
    // sendTransactionalEmail contracts never to reject, so reaching here means a
    // template bug. Log and swallow: the application is already saved.
    console.warn(`[application-received-email] send failed: ${err.message}`);
    return { sent: false };
  }
}

/**
 * Fire-and-forget wrapper. Exists so call sites read as a deliberate
 * non-awaited side effect instead of a floating promise someone later "fixes"
 * by adding an await that would put an email send on the apply response path.
 */
export function queueApplicationReceivedEmail(input, deps = {}) {
  void sendApplicationReceivedEmail(input, deps)
    .catch((err) => console.warn(`[application-received-email] unexpected: ${err.message}`));
}
