// FILE: src/services/public/apply-validators.js
// Field validation for the public apply form (SPEC §6.7). Each rule throws an
// HttpError(400, msg, CODE) with a stable field-level code. Name fields reject URL
// substrings (a common spam signal). Kept separate so apply-service stays small.

import { HttpError } from '../../middleware/error-handler-middleware.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /(https?:\/\/|www\.|\.[a-z]{2,}\/)/i;

function requireName(value, field, code) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 255) {
    throw new HttpError(400, `${field} is required (1–255 characters).`, code);
  }
  if (URL_RE.test(trimmed)) throw new HttpError(400, `${field} looks invalid.`, code);
  return trimmed;
}

/** Validate + normalize the text fields. Returns a clean object. Throws on error. */
export function validateApplicationForm(form = {}) {
  const firstName = requireName(form.firstName, 'First name', 'INVALID_FIRST_NAME');
  const lastName = requireName(form.lastName, 'Last name', 'INVALID_LAST_NAME');

  const email = String(form.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320) {
    throw new HttpError(400, 'A valid email is required.', 'INVALID_EMAIL');
  }

  const phoneRaw = String(form.phone ?? '').trim();
  if (phoneRaw.length > 32) throw new HttpError(400, 'Phone number is too long.', 'INVALID_PHONE');
  const phone = phoneRaw || null;

  let yearsExperience = null;
  if (form.yearsExperience !== undefined && form.yearsExperience !== null && `${form.yearsExperience}`.trim() !== '') {
    const years = Number(form.yearsExperience);
    if (!Number.isInteger(years) || years < 0 || years > 60) {
      throw new HttpError(400, 'Years of experience must be a whole number between 0 and 60.', 'INVALID_YEARS_EXPERIENCE');
    }
    yearsExperience = years;
  }

  const coverNoteRaw = String(form.coverNote ?? '').trim();
  if (coverNoteRaw.length > 5000) throw new HttpError(400, 'Cover note is too long.', 'INVALID_COVER_NOTE');
  const coverNote = coverNoteRaw || null;

  const dpdp = form.consent_dpdp === true || form.consent_dpdp === 'true';
  if (!dpdp) throw new HttpError(400, 'You must accept the privacy notice to apply.', 'CONSENT_REQUIRED');
  const futureOpportunities = form.consent_futureOpportunities === true || form.consent_futureOpportunities === 'true';

  return { firstName, lastName, email, phone, yearsExperience, coverNote, futureOpportunities };
}

/** True when the honeypot field is filled — a bot signal (R4). */
export function isHoneypotFilled(form = {}) {
  return typeof form.website_url === 'string' && form.website_url.trim() !== '';
}
