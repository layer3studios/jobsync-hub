// FILE: src/api/employer/employer-applicant-routes.js
// Applicant detail + actions. Mounted at /api/employer/applicants behind
// requireEmployer + requireEmployerCompany (server.js). requireEmployerApplicant
// tenant-verifies :applicationId and attaches req.application before any handler.
// The company is always read from req.employerCompanyId — never from input (§6.5).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireEmployerApplicant } from '../../middleware/require-employer-applicant-middleware.js';
import {
  requireInterviewerOrHigher, requireMemberOrHigher,
  requireCanMoveApplicants, requireCanArchiveApplicants,
} from '../../middleware/require-company-role-middleware.js';
import { getApplicantDetailForCompany } from '../../services/employer/applicant-detail-service.js';
import { moveApplicantToStage } from '../../services/employer/applicant-move-service.js';
import { archiveApplicant, unarchiveApplicant, bulkArchiveApplicants } from '../../services/employer/applicant-archive-service.js';
import { rescoreApplicantForCompany } from '../../services/employer/rescore-service.js';
import { signResumeToken, RESUME_URL_TTL_MS } from '../../services/employer/signed-url-service.js';
import {
  createApplicantNoteForApplicant, listApplicantNotesForApplicant,
} from '../../services/employer/applicant-notes-service.js';

const router = Router();

// POST /api/employer/applicants/bulk/archive — { applicationIds, reasonId, note? }.
// MUST precede the /:applicationId routes: Express matches in declaration order, so a
// static path after a parameterized one would be captured as an applicationId (R2).
// No requireEmployerApplicant — the service does its own per-item ownership check.
router.post('/bulk/archive', requireCanArchiveApplicants, asyncHandler(async (req, res) => {
  const { applicationIds, reasonId, note } = req.body || {};
  const result = await bulkArchiveApplicants(
    req.employerCompanyId, { applicationIds, reasonId, note }, req.employerUser.employerUserId,
  );
  res.json(result);
}));

// GET /api/employer/applicants/:applicationId — full detail (D2).
router.get('/:applicationId', requireInterviewerOrHigher, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const applicant = await getApplicantDetailForCompany(req.employerCompanyId, req.application._id);
  res.json({ applicant });
}));

// POST /api/employer/applicants/:applicationId/move — { stageId, note? }.
router.post('/:applicationId/move', requireCanMoveApplicants, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const { stageId, note } = req.body || {};
  const result = await moveApplicantToStage(
    req.employerCompanyId, req.application._id, { stageId, note }, req.employerUser.employerUserId,
  );
  res.json(result);
}));

// POST /api/employer/applicants/:applicationId/archive — { reasonId, note? }.
router.post('/:applicationId/archive', requireCanArchiveApplicants, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const { reasonId, note } = req.body || {};
  const result = await archiveApplicant(
    req.employerCompanyId, req.application._id, { reasonId, note }, req.employerUser.employerUserId,
  );
  res.json(result);
}));

// POST /api/employer/applicants/:applicationId/unarchive.
router.post('/:applicationId/unarchive', requireCanArchiveApplicants, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const result = await unarchiveApplicant(
    req.employerCompanyId, req.application._id, req.employerUser.employerUserId,
  );
  res.json(result);
}));

// POST /api/employer/applicants/:applicationId/rescore — requeue AI scoring.
// 202 when a job was reset or inserted; 200 when one was already in flight (C9/C10).
router.post('/:applicationId/rescore', requireMemberOrHigher, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const result = await rescoreApplicantForCompany(req.employerCompanyId, req.application._id);
  res.status(result.rescored ? 202 : 200).json(result);
}));

// GET /api/employer/applicants/:applicationId/resume-url — signed 15-min URL.
router.get('/:applicationId/resume-url', requireInterviewerOrHigher, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const token = signResumeToken(req.application._id, RESUME_URL_TTL_MS);
  res.json({
    url: `/api/public/resume-download?token=${token}`,
    expiresAt: new Date(Date.now() + RESUME_URL_TTL_MS),
  });
}));

// GET /api/employer/applicants/:applicationId/notes — newest first (C3/D5).
router.get('/:applicationId/notes', requireInterviewerOrHigher, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const notes = await listApplicantNotesForApplicant(req.employerCompanyId, req.application._id);
  res.json({ notes });
}));

// POST /api/employer/applicants/:applicationId/notes — { body }. 201 with the new note.
router.post('/:applicationId/notes', requireInterviewerOrHigher, requireEmployerApplicant, asyncHandler(async (req, res) => {
  const note = await createApplicantNoteForApplicant(
    req.employerCompanyId, req.application._id, req.employerUser.employerUserId, req.body?.body,
  );
  res.status(201).json({ note });
}));

export default router;
