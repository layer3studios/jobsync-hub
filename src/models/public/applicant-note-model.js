// FILE: src/models/public/applicant-note-model.js
// applicant_notes collection — append-only employer observations on one application
// (C3/D1). Append-only by design: no update or delete helper exists, so history can
// never be rewritten. Every query is companyId-scoped (§6.5) — the compound index
// serves the companyId+applicationId read path and its companyId-only prefix.
// Author fields are denormalized snapshots written by the service (D7/R2); this
// model never joins employer_users.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const DEFAULT_NOTE_LIMIT = 100;

const applicantNotesCol = () => col('applicant_notes');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureApplicantNoteIndexes() {
  const collection = await applicantNotesCol();
  await collection.createIndex(
    { companyId: 1, applicationId: 1, createdAt: -1 },
    { name: 'applicant_notes_company_application_createdAt' },
  );
}

/**
 * Insert one note. The caller (service layer) owns validation, the tenant assertion,
 * and the author snapshot — this writes what it is handed and stamps the timestamps.
 * updatedAt equals createdAt on insert (D1) and, being append-only, stays that way.
 */
export async function createApplicantNote(data) {
  const companyOid = toOid(data.companyId);
  const applicationOid = toOid(data.applicationId);
  if (!companyOid) throw new Error('createApplicantNote: invalid companyId');
  if (!applicationOid) throw new Error('createApplicantNote: invalid applicationId');

  const now = data.createdAt ?? new Date();
  const doc = {
    companyId: companyOid,
    applicationId: applicationOid,
    authorEmployerUserId: toOid(data.authorEmployerUserId),
    authorName: data.authorName ?? null,
    authorEmail: data.authorEmail,
    body: data.body,
    createdAt: now,
    updatedAt: now,
  };
  const collection = await applicantNotesCol();
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * List an application's notes, newest first. Scoped to the company (§6.5) — a note
 * on the same applicationId under another company is never returned. Unbounded reads
 * are refused: the limit defaults to 100 (C-scope: pagination is out of scope).
 */
export async function listApplicantNotesForApplication(companyId, applicationId, { limit = DEFAULT_NOTE_LIMIT } = {}) {
  const companyOid = toOid(companyId);
  const applicationOid = toOid(applicationId);
  if (!companyOid || !applicationOid) return [];
  const collection = await applicantNotesCol();
  return collection
    .find({ companyId: companyOid, applicationId: applicationOid })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/** Client-safe projection — ids as strings, timestamps as Dates (JSON → ISO, §9). */
export function toPublicApplicantNote(doc) {
  return {
    id: doc._id.toString(),
    applicationId: doc.applicationId.toString(),
    authorEmployerUserId: doc.authorEmployerUserId?.toString() ?? null,
    authorName: doc.authorName ?? null,
    authorEmail: doc.authorEmail,
    body: doc.body,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
