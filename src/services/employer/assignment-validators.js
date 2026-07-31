// FILE: src/services/employer/assignment-validators.js
// Shared validation for assignment create + patch. Each throws HttpError with a
// stable code on bad input and returns the normalized value on success. Mirrors
// posting-validators.js in style, with one deliberate divergence documented on
// validateAssignmentDescription below.
//
// Control characters are stripped BEFORE length is measured, so invisible padding
// can never buy a short field its way past a minimum.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { ALLOWED_FILE_TYPES } from '../../models/employer/assignment-model.js';

const MINIMUM_TITLE_LENGTH = 2;
const MAXIMUM_TITLE_LENGTH = 120;
const MINIMUM_PUBLIC_SUMMARY_LENGTH = 10;
const MAXIMUM_PUBLIC_SUMMARY_LENGTH = 300;
const MINIMUM_DESCRIPTION_LENGTH = 50;
const MAXIMUM_DESCRIPTION_LENGTH = 20000;
const MAXIMUM_INSTRUCTIONS_LENGTH = 5000;
const MINIMUM_ESTIMATED_HOURS = 1;
const MAXIMUM_ESTIMATED_HOURS = 8;

// Control chars except tab (\t = \x09) and newline (\n = \x0A).
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Strip control characters, then trim. Order matters: strip → trim → measure. */
function clean(value) {
  return value.replace(CONTROL_CHARACTERS, '').trim();
}

/** Title: required string, 2-120 chars after stripping + trimming. */
export function validateAssignmentTitle(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Title is required', 'INVALID_TITLE');
  }
  const cleaned = clean(value);
  if (cleaned.length < MINIMUM_TITLE_LENGTH || cleaned.length > MAXIMUM_TITLE_LENGTH) {
    throw new HttpError(400, 'Title must be 2-120 characters', 'INVALID_TITLE');
  }
  return cleaned;
}

/** Public summary (shown on the apply page): required, 10-300 chars. */
export function validateAssignmentPublicSummary(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'A public summary is required', 'INVALID_PUBLIC_SUMMARY');
  }
  const cleaned = clean(value);
  if (cleaned.length < MINIMUM_PUBLIC_SUMMARY_LENGTH || cleaned.length > MAXIMUM_PUBLIC_SUMMARY_LENGTH) {
    throw new HttpError(400, 'Public summary must be 10-300 characters', 'INVALID_PUBLIC_SUMMARY');
  }
  return cleaned;
}

/**
 * Description: markdown, 50-20000 chars after control-character stripping.
 *
 * Deliberately does NOT reject "<script", unlike validatePostingDescription.
 * Posting descriptions are plain text, so a script tag there is only ever an
 * attack. Assignment descriptions are MARKDOWN, rendered by react-markdown with
 * raw HTML disabled — a script tag is inert text on the way out. A frontend
 * take-home legitimately contains <script> inside a fenced code block, so
 * rejecting it here would break a real use case to prevent nothing. Store the raw
 * markdown; escaping is the renderer's job. Do not "harden" this.
 */
export function validateAssignmentDescription(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Description is required', 'INVALID_DESCRIPTION');
  }
  const cleaned = clean(value);
  if (cleaned.length < MINIMUM_DESCRIPTION_LENGTH || cleaned.length > MAXIMUM_DESCRIPTION_LENGTH) {
    throw new HttpError(400, 'Description must be 50-20000 characters', 'INVALID_DESCRIPTION');
  }
  return cleaned;
}

/** Submission instructions: optional markdown, up to 5000 chars. Absent → ''. */
export function validateSubmissionInstructions(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Submission instructions must be text', 'INVALID_INSTRUCTIONS');
  }
  const cleaned = clean(value);
  if (cleaned.length > MAXIMUM_INSTRUCTIONS_LENGTH) {
    throw new HttpError(400, 'Submission instructions must be 5000 characters or fewer', 'INVALID_INSTRUCTIONS');
  }
  return cleaned;
}

/** Estimated hours: integer 1-8. Rejects 2.5 and '2' — no coercion. */
export function validateEstimatedHours(value) {
  if (!Number.isInteger(value) || value < MINIMUM_ESTIMATED_HOURS || value > MAXIMUM_ESTIMATED_HOURS) {
    throw new HttpError(400, 'Estimated hours must be a whole number between 1 and 8', 'INVALID_ESTIMATED_HOURS');
  }
  return value;
}

/** Allowed file types: subset of the model's list, deduped. Absent → [] (link-only). */
export function validateAllowedFileTypes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, `Allowed file types must be an array of ${ALLOWED_FILE_TYPES.join(', ')}`, 'INVALID_FILE_TYPES');
  }
  const normalized = [];
  for (const entry of value) {
    if (!ALLOWED_FILE_TYPES.includes(entry)) {
      throw new HttpError(400, `Allowed file types must be a subset of ${ALLOWED_FILE_TYPES.join(', ')}`, 'INVALID_FILE_TYPES');
    }
    if (!normalized.includes(entry)) normalized.push(entry);
  }
  return normalized;
}
