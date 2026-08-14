// FILE: src/services/employer/notification-gate-service.js
// "Does this person want this email?" — the single check every team-facing sender
// asks before it sends.
//
// FAIL OPEN, ALWAYS. An unknown user, a missing preferences document, a DB hiccup:
// all answer true. The failure mode of guessing "yes" is one unwanted email; the
// failure mode of guessing "no" is someone silently never learning they were
// @mentioned, with nothing anywhere to show an email was suppressed. Those are not
// symmetric, so this never fails closed.
//
// CANDIDATE-FACING MAIL NEVER PASSES THROUGH HERE. Rejections, application receipts
// and interview invitations go to people who are not JobMesh users and have no
// preferences — gating them would be silently dropping mail the candidate is owed.
//
// The cache is a short TTL rather than a request-scoped map: these senders are
// called from workers and fire-and-forget paths that have no request to scope to. A
// preferences write invalidates the entry immediately, so the TTL only ever covers
// the gap between reads, never a stale value after a user changes a switch.

import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import {
  toNotificationPreferences, NOTIFICATION_EVENT_KEYS,
} from '../../models/employer/employer-user-profile-model.js';

const CACHE_TTL_MS = 30_000;

/** userId string → { preferences, expiresAt }. */
const cache = new Map();

/** Drop one user's cached preferences. Called by the PATCH handler after a write. */
export function invalidateNotificationCache(employerUserId) {
  if (employerUserId) cache.delete(String(employerUserId));
  else cache.clear();
}

async function loadPreferences(employerUserId) {
  const key = String(employerUserId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.preferences;

  let preferences;
  try {
    const user = await getEmployerUserById(employerUserId);
    // A user we cannot find gets defaults, not silence — see the header.
    preferences = toNotificationPreferences(user?.notificationPreferences);
  } catch (error) {
    console.warn(`[notify-gate] preference read failed for ${key}: ${error.message}`);
    return toNotificationPreferences(null);
  }
  cache.set(key, { preferences, expiresAt: Date.now() + CACHE_TTL_MS });
  return preferences;
}

/**
 * True when this user wants email for this event.
 *
 * An unknown eventType returns true and warns: a sender naming an event that does
 * not exist is a bug in the sender, and swallowing the email would hide it.
 */
export async function shouldNotify(employerUserId, eventType) {
  if (!employerUserId) return true;
  if (!NOTIFICATION_EVENT_KEYS.includes(eventType)) {
    console.warn(`[notify-gate] unknown event type "${eventType}" — allowing`);
    return true;
  }
  const preferences = await loadPreferences(employerUserId);
  return preferences[eventType] !== false;
}

/**
 * Keep only the recipients who want this event. Recipients are
 * { employerUserId, email } pairs; anything without an email is dropped regardless.
 */
export async function filterRecipientsByPreference(recipients, eventType) {
  const list = (recipients ?? []).filter((recipient) => recipient?.email);
  const verdicts = await Promise.all(
    list.map((recipient) => shouldNotify(recipient.employerUserId, eventType)),
  );
  return list.filter((_recipient, index) => verdicts[index]);
}
