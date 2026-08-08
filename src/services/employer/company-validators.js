// FILE: src/services/employer/company-validators.js
// Shared validation for company create + patch. Each throws HttpError with a
// stable code on bad input and returns the normalized value on success.

import { HttpError } from '../../middleware/error-handler-middleware.js';

const MAXIMUM_URL_LENGTH = 2048;
const MAXIMUM_TAGLINE_LENGTH = 120;
const MAXIMUM_ABOUT_LENGTH = 500;
const SOCIAL_LINK_KEYS = Object.freeze(['linkedin', 'twitter', 'github']);
const MAXIMUM_TEMPLATE_LENGTH = 1000;
// One key per rejection template the sender can choose between. Mirrors the three
// builders in services/email/templates/rejection-*.js.
export const REJECTION_TEMPLATE_KEYS = Object.freeze(['application', 'positionFilled', 'postInterview']);
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

/**
 * Optional company description, ≤ 500 chars after trimming. Empty/blank/absent →
 * null, matching validateTagline: the careers page then has exactly one falsy case
 * to render around rather than distinguishing '' from null.
 */
export function validateAbout(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'About must be text', 'INVALID_ABOUT');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAXIMUM_ABOUT_LENGTH) {
    throw new HttpError(400, 'About must be 500 characters or fewer', 'INVALID_ABOUT');
  }
  return trimmed;
}

/**
 * Optional { linkedin, twitter, github } URL map. Unknown keys are rejected rather
 * than dropped — silently ignoring a typo'd key would let an employer "save" a link
 * that never appears. An entirely empty map collapses to null so the careers page
 * can test one value instead of counting keys.
 */
export function validateSocialLinks(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'socialLinks must be an object', 'INVALID_SOCIAL_LINKS');
  }
  const links = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SOCIAL_LINK_KEYS.includes(key)) {
      throw new HttpError(400, `Unknown social link: ${key}`, 'INVALID_SOCIAL_LINKS');
    }
    // Reuses the shared URL rule, so a social link is held to the same http/https
    // and length checks as website and privacyPolicyUrl.
    const url = validateOptionalUrl(raw, 'INVALID_SOCIAL_LINKS');
    if (url) links[key] = url;
  }
  return Object.keys(links).length === 0 ? null : links;
}

/**
 * Optional per-stage rejection email bodies, ≤ 1000 chars each.
 *
 * An empty or blank body means "use the built-in default" and is dropped rather
 * than stored: persisting '' would send candidates a rejection email with no body.
 * A map that ends up empty collapses to null for the same reason.
 */
export function validateRejectionTemplates(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'rejectionEmailTemplates must be an object', 'INVALID_REJECTION_TEMPLATES');
  }
  const templates = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!REJECTION_TEMPLATE_KEYS.includes(key)) {
      throw new HttpError(400, `Unknown rejection template: ${key}`, 'INVALID_REJECTION_TEMPLATES');
    }
    if (raw == null) continue; // explicit reset to the default
    if (typeof raw !== 'string') {
      throw new HttpError(400, 'A rejection template must be text', 'INVALID_REJECTION_TEMPLATES');
    }
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.length > MAXIMUM_TEMPLATE_LENGTH) {
      throw new HttpError(400, 'A rejection template must be 1000 characters or fewer', 'INVALID_REJECTION_TEMPLATES');
    }
    templates[key] = trimmed;
  }
  return Object.keys(templates).length === 0 ? null : templates;
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
