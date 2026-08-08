// FILE: src/services/employer/company-validators.js
// Shared validation for company create + patch. Each throws HttpError with a
// stable code on bad input and returns the normalized value on success.

import { HttpError } from '../../middleware/error-handler-middleware.js';

const MAXIMUM_URL_LENGTH = 2048;
const MAXIMUM_TAGLINE_LENGTH = 120;
const MAXIMUM_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Company name: required string, 2–120 chars after trimming. */
export function validateName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw new HttpError(400, 'Company name must be 2–120 characters', 'INVALID_NAME');
  }
  return trimmed;
}

/**
 * Optional one-line company tagline, ≤ 120 chars after trimming. Empty, blank or
 * absent → null, so clearing the field in the UI stores null rather than '' and
 * the public careers page has exactly one falsy case to render around.
 */
export function validateTagline(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Tagline must be text', 'INVALID_TAGLINE');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAXIMUM_TAGLINE_LENGTH) {
    throw new HttpError(400, 'Tagline must be 120 characters or fewer', 'INVALID_TAGLINE');
  }
  return trimmed;
}

/** Optional http/https URL ≤ 2048 chars. Empty/absent → null. */
export function validateOptionalUrl(value, code) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAXIMUM_URL_LENGTH) {
    throw new HttpError(400, 'URL is invalid or too long', code);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, 'URL is invalid', code);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'URL must use http or https', code);
  }
  return value;
}

/** Retention period in days: integer in [30, 3650]. Absent → default 365 (R2). */
export function validateRetentionDays(value) {
  if (value == null) return 365;
  if (!Number.isInteger(value) || value < 30 || value > 3650) {
    throw new HttpError(400, 'retentionDays must be an integer between 30 and 3650', 'INVALID_RETENTION_DAYS');
  }
  return value;
}

/** Optional grievance-officer email ≤ 254 chars. Empty/absent → null. */
export function validateDpoEmail(value) {
  if (value == null || value === '') return null;
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!trimmed || trimmed.length > MAXIMUM_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
    throw new HttpError(400, 'A valid grievance-officer email is required', 'INVALID_DPO_EMAIL');
  }
  return trimmed;
}
