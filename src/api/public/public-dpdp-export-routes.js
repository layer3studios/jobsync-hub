// FILE: src/api/public/public-dpdp-export-routes.js
// The candidate-facing DPDP right of access. Unauthenticated by necessity: a
// candidate has no JobMesh account, and the emailed one-time token is the credential.
//
// Neither endpoint reveals whether an email is known to a company. The request
// endpoint always answers the same 202; the download endpoint answers 404 for
// unknown, expired and already-used tokens alike.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  requestCandidateDataExport, redeemCandidateDataExport,
} from '../../services/dpdp/candidate-self-export-service.js';

const router = Router();

// The same sentence for every outcome — see the file header.
const ACCEPTED_MESSAGE =
  "If we hold data for that email, we've sent a download link to it. The link expires in 24 hours.";

// POST /api/public/dpdp/export — { email, companySlug }. Always 202.
router.post('/export', asyncHandler(async (req, res) => {
  const { email, companySlug } = req.body || {};
  await requestCandidateDataExport({ email, companySlug, ipAddress: req.ip ?? null });
  res.status(202).json({ message: ACCEPTED_MESSAGE });
}));

// GET /api/public/dpdp/export/download?token=… — redeems the one-time link and
// streams the JSON as an attachment. Single-use: a refresh returns 404.
router.get('/export/download', asyncHandler(async (req, res) => {
  const result = await redeemCandidateDataExport(req.query.token);
  if (!result) {
    throw new HttpError(404, 'This link has expired or has already been used', 'EXPORT_LINK_INVALID');
  }
  const date = result.generatedAt.toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="my-data-export-${date}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(result, null, 2));
}));

export default router;
