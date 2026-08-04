// FILE: src/middleware/require-employer-submission-middleware.js
// Loads the :submissionId assignment submission scoped to the caller's company and
// attaches it as req.assignmentSubmission. Runs AFTER requireEmployer +
// requireEmployerCompany, so req.employerCompanyId is set. A cross-tenant id
// resolves to null and is reported as 404 — never leaking that another company's
// submission exists (§6.5/C7). Mirrors require-employer-applicant-middleware.js.

import { ObjectId } from 'mongodb';
import { HttpError } from './error-handler-middleware.js';
import { getAssignmentSubmissionForCompany } from '../models/public/assignment-submission-model.js';

export async function requireEmployerSubmission(req, _res, next) {
  try {
    const { submissionId } = req.params;
    if (!ObjectId.isValid(submissionId)) {
      return next(new HttpError(400, 'Invalid submission id', 'INVALID_SUBMISSION_ID'));
    }
    const submission = await getAssignmentSubmissionForCompany(req.employerCompanyId, submissionId);
    if (!submission) return next(new HttpError(404, 'Submission not found', 'SUBMISSION_NOT_FOUND'));
    req.assignmentSubmission = submission;
    next();
  } catch (err) {
    next(err);
  }
}

export default requireEmployerSubmission;
