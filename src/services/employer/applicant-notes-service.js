// FILE: src/services/employer/applicant-notes-service.js
// Employer notes on an applicant (C3). Append-only: create + list, no edit or delete.
// Notes are plain text (R3) — control characters are stripped and "<script" is refused
// outright, matching validatePostingDescription. The author's name + email are snapshot
// onto the note at write time (D7/R2): the note is immutable history, so a later rename
// of the employer user must not rewrite what was already recorded.
//
// companyId always arrives from req.employerCompanyId, never from input (§6.5). The
// application is re-fetched company-scoped here as defence-in-depth: the route already
// tenant-verifies it via requireEmployerApplicant, but the service refuses to trust that.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany } from '../../models/public/application-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import {
  createApplicantNote, listApplicantNotesForApplication, toPublicApplicantNote,
} from '../../models/public/applicant-note-model.js';

const MINIMUM_BODY_LENGTH = 1;
const MAXIMUM_BODY_LENGTH = 4000;
const SCRIPT_PATTERN = /<script/i;
// Control chars except tab (\t = \x09) and newline (\n = \x0A) — same set as posting-validators.
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Note body: plain text, 1-4000 chars. Control chars are stripped BEFORE the length
 * check so an invisible-padded body cannot buy extra length, then trimmed. One stable
 * code for every failure (D6) — the message carries the human-readable reason.
 */
export function validateApplicantNoteBody(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Note body is required', 'INVALID_NOTE_BODY');
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (cleaned.length < MINIMUM_BODY_LENGTH) {
    throw new HttpError(400, 'Note cannot be empty', 'INVALID_NOTE_BODY');
  }
  if (cleaned.length > MAXIMUM_BODY_LENGTH) {
    throw new HttpError(400, 'Note must be 4000 characters or fewer', 'INVALID_NOTE_BODY');
  }
  if (SCRIPT_PATTERN.test(cleaned)) {
    throw new HttpError(400, 'Note must be plain text', 'INVALID_NOTE_BODY');
  }
  return cleaned;
}

/** The application, or 404 — cross-tenant ids are indistinguishable from missing (§6.5). */
async function requireApplicationForCompany(companyId, applicationId) {
  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  // Defence-in-depth (C6): the model already filtered on companyId — assert it held.
  if (application.companyId?.toString() !== companyId?.toString()) {
    throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  }
  return application;
}

/**
 * Append one note to an application. The author snapshot is mandatory: a note whose
 * employer user cannot be loaded (soft-deleted, stale cookie) is refused with 401
 * rather than written with null author fields (D7).
 */
export async function createApplicantNoteForApplicant(companyId, applicationId, authorEmployerUserId, body) {
  const cleanBody = validateApplicantNoteBody(body);
  const application = await requireApplicationForCompany(companyId, applicationId);

  const author = await getEmployerUserById(authorEmployerUserId);
  if (!author) throw new HttpError(401, 'Author not found', 'AUTHOR_NOT_FOUND');

  const note = await createApplicantNote({
    companyId,
    applicationId: application._id,
    authorEmployerUserId: author._id,
    authorName: author.name ?? null,
    authorEmail: author.email,
    body: cleanBody,
  });
  return toPublicApplicantNote(note);
}

/** An application's notes, newest first, in the client shape. */
export async function listApplicantNotesForApplicant(companyId, applicationId) {
  const notes = await listApplicantNotesForApplication(companyId, applicationId);
  return notes.map(toPublicApplicantNote);
}
