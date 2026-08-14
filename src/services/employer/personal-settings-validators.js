// FILE: src/services/employer/personal-settings-validators.js
// Validation for the personal-settings patch. Same shape as posting-validators:
// each function returns the normalized value or throws HttpError with a stable code.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  MAXIMUM_JOB_TITLE_LENGTH, NOTIFICATION_EVENT_KEYS,
} from '../../models/employer/employer-user-profile-model.js';

/**
 * Every IANA zone this Node build knows, as a Set, computed once.
 *
 * Intl.supportedValuesOf is the authority rather than a hand-kept list: the tz
 * database changes (zones get added, renamed, merged) and a literal array would
 * start rejecting valid zones the moment Node updates. Wrapped in a try because the
 * API is Node 18+ — on anything older the check degrades to a shape check rather
 * than rejecting every timezone outright.
 */
const SUPPORTED_TIMEZONES = (() => {
  try {
    return new Set(Intl.supportedValuesOf('timeZone'));
  } catch {
    return null;
  }
})();

/** A supported IANA zone id. Anything else → 400. */
export function validateTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'A timezone is required.', 'INVALID_TIMEZONE');
  }
  const zone = value.trim();
  if (SUPPORTED_TIMEZONES) {
    if (!SUPPORTED_TIMEZONES.has(zone)) {
      throw new HttpError(400, 'That is not a recognised timezone.', 'INVALID_TIMEZONE');
    }
    return zone;
  }
  // Fallback path: let Intl itself decide by trying to format with the zone.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
  } catch {
    throw new HttpError(400, 'That is not a recognised timezone.', 'INVALID_TIMEZONE');
  }
  return zone;
}

/** Trimmed job title, ≤60 chars. An empty string clears it back to null. */
export function validateJobTitle(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Job title must be text.', 'INVALID_JOB_TITLE');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAXIMUM_JOB_TITLE_LENGTH) {
    throw new HttpError(
      400, `Job title must be ${MAXIMUM_JOB_TITLE_LENGTH} characters or fewer.`, 'INVALID_JOB_TITLE',
    );
  }
  return trimmed;
}

/**
 * A partial notification patch: known keys only, boolean values only.
 *
 * An unknown key is a 400 rather than a silent drop — a client sending
 * `interviewSceduled` deserves to be told, not to watch a toggle refuse to stick.
 */
export function validateNotificationPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Notification preferences must be an object.', 'INVALID_NOTIFICATION_PREFERENCES');
  }
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!NOTIFICATION_EVENT_KEYS.includes(key)) {
      throw new HttpError(400, `Unknown notification event: ${key}`, 'UNKNOWN_NOTIFICATION_EVENT');
    }
    if (typeof value !== 'boolean') {
      throw new HttpError(400, `${key} must be true or false.`, 'INVALID_NOTIFICATION_PREFERENCES');
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'No preferences supplied.', 'INVALID_NOTIFICATION_PREFERENCES');
  }
  return patch;
}
