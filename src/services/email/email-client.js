// FILE: src/services/email/email-client.js
// Process-wide singleton for the Resend client, same shape as gemma-runtime.js:
// lazily built, memoized, and null when no key is configured. A missing
// RESEND_API_KEY is a normal, logged, non-throwing condition — the server boots
// fine without email, exactly like Gemma with no keys.

import { Resend } from 'resend';
import { RESEND_API_KEY } from '../../env.js';

let emailClient = null;
let initialized = false;

/** The memoized Resend client, or null when RESEND_API_KEY is empty. */
export function getEmailClient() {
  if (initialized) return emailClient;
  initialized = true;

  if (!RESEND_API_KEY) {
    console.log('[email] No RESEND_API_KEY configured — outbound email disabled');
    return null;
  }

  emailClient = new Resend(RESEND_API_KEY);
  console.log('[email] Resend client initialized');
  return emailClient;
}
