// FILE: src/services/email/send-email-service.js
// Fire-and-forget transactional email over Resend. CONTRACT: this function
// NEVER rejects — every failure path resolves to { sent: false, code, emailId:
// null }, so callers can await it (or not) without a try/catch and never break
// their own flow. Dependencies are injectable so tests never touch the network.
// Logging never includes the API key or the recipient's full address — only the
// domain portion after '@'.

import {
  EMAIL_ENABLED, EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME, EMAIL_REPLY_TO_ADDRESS,
} from '../../env.js';
import { getEmailClient as defaultGetEmailClient } from './email-client.js';
import { EMAIL_ERROR_CODES } from './email-constants.js';

let disabledLogged = false;

function failure(code) {
  return { sent: false, code, emailId: null };
}

/** Only the domain half of an address — safe to log. */
function recipientDomain(to) {
  return typeof to === 'string' ? to.split('@')[1] || 'unknown' : 'unknown';
}

/** Map a Resend error object/exception to one of our stable codes. */
function codeForError(error) {
  return error?.name === 'rate_limit_exceeded'
    ? EMAIL_ERROR_CODES.RATE_LIMITED
    : EMAIL_ERROR_CODES.SEND_FAILED;
}

/**
 * Send one transactional email. Resolves (never rejects) with
 * { sent, code, emailId }. Attachments pass straight through, including each
 * attachment's contentType — the installed resend SDK (6.18.1) supports it
 * natively (Attachment.contentType). idempotencyKey is forwarded as the
 * Idempotency-Key header via the SDK's second send() argument.
 */
export async function sendTransactionalEmail(
  { to, subject, html, text, attachments, idempotencyKey },
  deps = {},
) {
  const {
    getEmailClient = defaultGetEmailClient,
    emailEnabled = EMAIL_ENABLED,
  } = deps;

  if (!emailEnabled) {
    if (!disabledLogged) {
      console.log('[email] EMAIL_ENABLED is false — skipping all sends');
      disabledLogged = true;
    }
    return failure(EMAIL_ERROR_CODES.EMAIL_DISABLED);
  }

  const client = getEmailClient();
  if (!client) {
    if (!disabledLogged) {
      console.log('[email] No email client configured — skipping all sends');
      disabledLogged = true;
    }
    return failure(EMAIL_ERROR_CODES.EMAIL_NOT_CONFIGURED);
  }

  if (typeof to !== 'string' || !to.trim() || !to.includes('@')) {
    return failure(EMAIL_ERROR_CODES.INVALID_RECIPIENT);
  }

  const payload = {
    from: `${EMAIL_FROM_NAME} <${EMAIL_FROM_ADDRESS}>`,
    to,
    subject,
    html,
    text,
  };
  if (EMAIL_REPLY_TO_ADDRESS) payload.replyTo = EMAIL_REPLY_TO_ADDRESS;
  if (attachments) payload.attachments = attachments;

  try {
    const options = idempotencyKey ? { idempotencyKey } : undefined;
    const { data, error } = await client.emails.send(payload, options);
    if (error) {
      console.warn(`[email] Send failed (to @${recipientDomain(to)}): ${error.message}`);
      return failure(codeForError(error));
    }
    return { sent: true, code: null, emailId: data?.id ?? null };
  } catch (err) {
    console.warn(`[email] Send threw (to @${recipientDomain(to)}): ${err.message}`);
    return failure(codeForError(err));
  }
}
