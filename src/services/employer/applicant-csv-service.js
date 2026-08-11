// FILE: src/services/employer/applicant-csv-service.js
// Builds the applicant CSV for one posting. No CSV library: the format is small
// enough that the escaping rule (RFC 4180 — wrap every value in quotes, double any
// internal quote) is safer written out than pulled in.
//
// EVERY value is quoted, not just the risky ones. A name like `O'Brien, Jr. "Bob"`
// and an empty phone then travel the same path, and a spreadsheet never has to
// guess. Missing values are empty cells — never the string "null".

import { listApplicationsForJob } from '../../models/public/application-model.js';
import { getContactForCompany } from '../../models/public/contact-model.js';
import { listResumeScoresForJob } from '../../models/public/resume-score-model.js';
import { mapStageNamesById } from './dashboard-helpers.js';

const COLUMNS = [
  'First Name', 'Last Name', 'Email', 'Phone', 'Stage', 'AI Score', 'Applied Date',
  'Source', 'Tags', 'Location', 'Experience', 'Current Stage Duration (days)',
];

/** One CSV field: always quoted, internal quotes doubled, newlines preserved inside. */
function escapeField(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** Split a free-text full name into first + rest. A single word is all first name. */
function splitName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** ISO date only (YYYY-MM-DD) — spreadsheets parse it as a date in every locale. */
function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** Whole days since the application last changed stage. */
function daysSince(value, now) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000));
}

/** Rows for one posting's non-archived applicants, in the ranked default order. */
export async function buildApplicantCsvRows(companyId, jobId, now = new Date()) {
  const applications = await listApplicationsForJob(companyId, jobId, { archived: false });
  if (applications.length === 0) return [];

  const contactIds = [...new Set(
    applications.map((application) => application.contactId?.toString()).filter(Boolean),
  )];
  const [contacts, scores, stageNameById] = await Promise.all([
    Promise.all(contactIds.map((contactId) => getContactForCompany(companyId, contactId))),
    listResumeScoresForJob(companyId, jobId, applications.map((application) => application._id)),
    mapStageNamesById(companyId),
  ]);
  const contactById = new Map(contacts.filter(Boolean).map((doc) => [doc._id.toString(), doc]));
  const scoreByApplicationId = new Map(scores.map((doc) => [doc.applicationId.toString(), doc]));

  return applications.map((application) => {
    const contact = contactById.get(application.contactId?.toString()) ?? null;
    const score = scoreByApplicationId.get(application._id.toString()) ?? null;
    const { first, last } = splitName(contact?.fullName);
    return [
      first,
      last,
      contact?.email ?? '',
      contact?.phone ?? '',
      stageNameById.get(application.stageId?.toString()) ?? '',
      score?.score ?? '',
      isoDate(application.appliedAt),
      application.source ?? '',
      (application.tags ?? []).join(', '),
      contact?.location ?? '',
      score?.experienceFit ?? (application.yearsExperience ?? ''),
      daysSince(application.lastStageMovedAt ?? application.appliedAt, now),
    ];
  });
}

/** Header + rows as one CRLF-delimited CSV string (CRLF is what Excel expects). */
export function renderCsv(rows) {
  return [COLUMNS, ...rows]
    .map((row) => row.map(escapeField).join(','))
    .join('\r\n');
}

/** e.g. "senior-backend-engineer-applicants-2026-08-11.csv". */
export function csvFilenameFor(posting, now = new Date()) {
  const slug = String(posting?.slug || 'posting').replace(/[^a-z0-9-]/gi, '') || 'posting';
  return `${slug}-applicants-${isoDate(now)}.csv`;
}

/** Everything the route needs: the file body, its name, and the row count. */
export async function buildApplicantCsvExport(companyId, posting, now = new Date()) {
  const rows = await buildApplicantCsvRows(companyId, posting._id, now);
  return { csv: renderCsv(rows), filename: csvFilenameFor(posting, now), count: rows.length };
}

export { COLUMNS as CSV_COLUMNS, escapeField };
