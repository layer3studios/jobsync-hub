// FILE: src/services/employer/posting-validators.js
// Shared validation for native posting create + patch. Each throws HttpError
// with a stable code on bad input and returns the normalized value on success.
// Descriptions are plain text only for MVP (R2): control characters are stripped
// and any "<script" substring is rejected outright.

import { HttpError } from '../../middleware/error-handler-middleware.js';

const MAXIMUM_TITLE_LENGTH = 200;
const MAXIMUM_LOCATION_LENGTH = 200;
const MINIMUM_DESCRIPTION_LENGTH = 50;
const MAXIMUM_DESCRIPTION_LENGTH = 50000;
const MAXIMUM_SALARY = 1_000_000_000; // INR 100 cr defensive cap (R5)
const SCRIPT_PATTERN = /<script/i;
// Control chars except tab (\t = \x09) and newline (\n = \x0A).
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export const WORKPLACE_TYPES = Object.freeze(['remote', 'hybrid', 'onsite']);
export const EMPLOYMENT_TYPES = Object.freeze(['full-time', 'part-time', 'contract', 'internship']);
export const POSTING_STATUSES = Object.freeze(['draft', 'active', 'closed']);

/** Title: required string, 2-200 chars after trimming, no "<script". */
export function validatePostingTitle(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 2 || trimmed.length > MAXIMUM_TITLE_LENGTH || SCRIPT_PATTERN.test(trimmed)) {
    throw new HttpError(400, 'Title must be 2-200 characters of plain text', 'INVALID_TITLE');
  }
  return trimmed;
}

/** Description: plain text 50-50000 chars; strips control chars, rejects "<script". */
export function validatePostingDescription(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Description is required', 'INVALID_DESCRIPTION');
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (cleaned.length < MINIMUM_DESCRIPTION_LENGTH || cleaned.length > MAXIMUM_DESCRIPTION_LENGTH
      || SCRIPT_PATTERN.test(cleaned)) {
    throw new HttpError(400, 'Description must be 50-50000 characters of plain text', 'INVALID_DESCRIPTION');
  }
  return cleaned;
}

/** Location: required string, 1-200 chars after trimming. */
export function validatePostingLocation(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > MAXIMUM_LOCATION_LENGTH) {
    throw new HttpError(400, 'Location must be 1-200 characters', 'INVALID_LOCATION');
  }
  return trimmed;
}

export function validateWorkplaceType(value) {
  if (!WORKPLACE_TYPES.includes(value)) {
    throw new HttpError(400, 'Workplace type must be remote, hybrid or onsite', 'INVALID_WORKPLACE_TYPE');
  }
  return value;
}

export function validateEmploymentType(value) {
  if (!EMPLOYMENT_TYPES.includes(value)) {
    throw new HttpError(400, 'Employment type is invalid', 'INVALID_EMPLOYMENT_TYPE');
  }
  return value;
}

export function validatePostingStatus(value) {
  if (!POSTING_STATUSES.includes(value)) {
    throw new HttpError(400, 'Status must be draft, active or closed', 'INVALID_STATUS');
  }
  return value;
}

function normalizeSalaryAmount(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_SALARY) {
    throw new HttpError(400, 'Salary must be a whole number between 0 and 1000000000', 'INVALID_SALARY');
  }
  return value;
}

/** Both optional; if both present enforce min <= max. Returns normalized pair. */
export function validateSalary(min, max) {
  const salaryMin = normalizeSalaryAmount(min);
  const salaryMax = normalizeSalaryAmount(max);
  if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
    throw new HttpError(400, 'salaryMin must be less than or equal to salaryMax', 'INVALID_SALARY');
  }
  return { salaryMin, salaryMax };
}

/**
 * Optional application deadline. Accepts an ISO string or Date; empty/absent → null.
 *
 * "Future" is judged against NOW at validation time, which means an edit that does
 * not touch the deadline can still be rejected once the date has passed. Callers
 * therefore only validate it when the key is actually present in the body — see
 * buildPatch in employer-postings-routes.js.
 */
export function validateApplicationDeadline(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'Application deadline must be a valid date', 'INVALID_DEADLINE');
  }
  if (parsed.getTime() <= Date.now()) {
    throw new HttpError(400, 'Application deadline must be in the future', 'INVALID_DEADLINE');
  }
  return parsed;
}

/** Strict boolean — a missing value is false, but a non-boolean is a caller bug. */
export function validateAutoCloseOnDeadline(value) {
  if (value == null) return false;
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'autoCloseOnDeadline must be true or false', 'INVALID_AUTO_CLOSE');
  }
  return value;
}

/**
 * Cross-field rule: auto-close needs a date to close ON. Enforced here rather than
 * in either single-field validator because neither can see the other.
 *
 * Clearing the deadline also clears auto-close: leaving the flag set with no date
 * would arm a rule that can never fire.
 */
export function reconcileDeadlineFields(applicationDeadline, autoCloseOnDeadline) {
  if (applicationDeadline == null) return { applicationDeadline: null, autoCloseOnDeadline: false };
  return { applicationDeadline, autoCloseOnDeadline };
}
