// FILE: src/api/employer/employer-candidate-export-routes.js
// GET /api/employer/applicants/:applicationId/export — one candidate's whole record
// as a downloadable file. Mounted alongside employer-applicant-routes, so it inherits
// requireEmployer + requireEmployerCompany and tenant-verifies :applicationId through
// requireEmployerApplicant like every other route on that path.
//
// Member+ rather than Interviewer+: reading one applicant's page is triage, but
// pulling their entire record into a file that leaves the building is not.
//
// JSON is the real format — nested, lossless, and what a DPDP access request should
// receive. ?format=csv is a convenience for spreadsheets and is deliberately FLAT
// and lossy: one row of headline fields, with notes and interviews reduced to counts.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireEmployerApplicant } from '../../middleware/require-employer-applicant-middleware.js';
import { requireMemberOrHigher } from '../../middleware/require-company-role-middleware.js';
import {
  buildCandidateExport, exportFilenameSlug, EXPORT_AUDIENCES,
} from '../../services/employer/candidate-export-service.js';

const router = Router();

/** RFC 4180: every field quoted, internal quotes doubled — same rule as the bulk CSV. */
const escapeField = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const CSV_COLUMNS = [
  ['Name', (e) => e.contact.fullName],
  ['Email', (e) => e.contact.email],
  ['Phone', (e) => e.contact.phone],
  ['Location', (e) => e.contact.location],
  ['Posting', (e) => e.application.postingTitle],
  ['Stage', (e) => e.application.currentStage],
  ['Applied At', (e) => e.application.appliedAt],
  ['Source', (e) => e.application.source],
  ['AI Score', (e) => e.score?.score],
  ['AI Tier', (e) => e.score?.tier],
  ['Matched Skills', (e) => (e.score?.matchedSkills ?? []).join('; ')],
  ['Notes', (e) => e.notes.length],
  ['Interviews', (e) => e.interviews.length],
];

function toCsv(exportDoc) {
  const header = CSV_COLUMNS.map(([name]) => escapeField(name)).join(',');
  const row = CSV_COLUMNS.map(([, read]) => escapeField(read(exportDoc))).join(',');
  return `${header}\r\n${row}\r\n`;
}

/** "alex-kumar-data-export-2026-08-12.json" */
function attachmentName(exportDoc, extension) {
  const date = exportDoc.generatedAt.toISOString().slice(0, 10);
  return `${exportFilenameSlug(exportDoc.contact.fullName)}-data-export-${date}.${extension}`;
}

router.get('/:applicationId/export', requireMemberOrHigher, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const exportDoc = await buildCandidateExport(req.employerCompanyId, req.application._id, {
    audience: EXPORT_AUDIENCES.EMPLOYER,
  });
  const wantsCsv = req.query.format === 'csv';
  const extension = wantsCsv ? 'csv' : 'json';

  res.setHeader('Content-Disposition', `attachment; filename="${attachmentName(exportDoc, extension)}"`);
  if (wantsCsv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(toCsv(exportDoc));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(exportDoc, null, 2));
}));

export default router;
