// FILE: src/api/employer/employer-export-routes.js
// CSV export of a posting's applicants. Mounted at /api/employer/jobs behind
// requireEmployer + requireEmployerCompany (server.js); requireEmployerPosting
// tenant-verifies :postingId. Member+ only — an export lifts every candidate's
// contact details out of the product in one file, which is not an interviewer's
// call to make.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireEmployerPosting } from '../../middleware/require-employer-posting-middleware.js';
import { requireMemberOrHigher } from '../../middleware/require-company-role-middleware.js';
import { buildApplicantCsvExport } from '../../services/employer/applicant-csv-service.js';

const router = Router();

// GET /api/employer/jobs/:postingId/export/csv — downloads the file.
router.get(
  '/:postingId/export/csv',
  requireMemberOrHigher,
  requireEmployerPosting,
  asyncHandler(async (req, res) => {
    const { csv, filename, count } = await buildApplicantCsvExport(req.employerCompanyId, req.posting);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Lets the browser-side fetch report "Exported 42 applicants" without parsing
    // the body it is about to hand to a download.
    res.setHeader('X-Applicant-Count', String(count));
    res.setHeader('Access-Control-Expose-Headers', 'X-Applicant-Count, Content-Disposition');
    // A BOM so Excel opens UTF-8 names (Kiran Śrī, 北京) correctly instead of mojibake.
    res.send(`﻿${csv}`);
  }),
);

export default router;
