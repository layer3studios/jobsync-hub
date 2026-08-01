// FILE: src/api/employer/employer-interview-routes.js
// Interview scheduling HTTP surface. Mounted at /api/employer behind
// requireEmployer + requireEmployerCompany (server.js). companyId always comes
// from req.employerCompanyId — never from input (§6.5). Role gating: reading is
// interviewer-or-higher; creating, rescheduling and cancelling are
// member-or-higher. All business logic lives in src/services/interview/.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  requireInterviewerOrHigher, requireMemberOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import {
  proposeInterviewForCompany, rescheduleInterviewForCompany,
} from '../../services/interview/interview-scheduling-service.js';
import { cancelInterviewForCompanyWithNotice } from '../../services/interview/interview-cancel-service.js';
import { submitInterviewFeedback, handleNoShow } from '../../services/interview/interview-feedback-service.js';
import { sendPoolSchedulingLink } from '../../services/interview/pool-scheduling-service.js';
import {
  listInterviewsForApplication, toPublicInterview, INTERVIEW_ERROR_CODES,
} from '../../models/interview/index.js';

const router = Router();

/** JSON gives ISO strings; the validators require Date instances. */
function parseProposedSlots(slots) {
  if (!Array.isArray(slots)) return slots;
  return slots.map((slot) => ({
    startAtUtc: new Date(slot?.startAtUtc),
    durationMinutes: slot?.durationMinutes,
  }));
}

// POST /api/employer/applicants/:applicationId/interviews — propose slots.
router.post('/applicants/:applicationId/interviews', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const interview = await proposeInterviewForCompany(
    req.employerCompanyId,
    req.params.applicationId,
    {
      proposedSlots: parseProposedSlots(body.proposedSlots),
      durationMinutes: body.durationMinutes,
      mode: body.mode,
      meetingUrl: body.meetingUrl,
      locationText: body.locationText,
      interviewerEmployerUserIds: body.interviewerEmployerUserIds,
      timezoneId: body.timezoneId,
    },
    req.employerUser.employerUserId,
  );
  res.status(201).json({ data: toPublicInterview(interview) });
}));

// POST /api/employer/applicants/:applicationId/send-scheduling-link — one-click
// pool invite; everything comes from the posting's defaults + pool.
router.post('/applicants/:applicationId/send-scheduling-link', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const interview = await sendPoolSchedulingLink(
    req.employerCompanyId, req.params.applicationId, req.employerUser.employerUserId,
  );
  res.status(201).json({ data: toPublicInterview(interview) });
}));

// GET /api/employer/applicants/:applicationId/interviews — read-only list.
router.get('/applicants/:applicationId/interviews', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const interviews = await listInterviewsForApplication(req.employerCompanyId, req.params.applicationId);
  res.json({ data: interviews.map(toPublicInterview) });
}));

// POST /api/employer/interviews/:interviewId/reschedule — { proposedSlots }.
router.post('/interviews/:interviewId/reschedule', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const interview = await rescheduleInterviewForCompany(
    req.employerCompanyId,
    req.params.interviewId,
    parseProposedSlots(req.body?.proposedSlots),
    req.employerUser.employerUserId,
  );
  res.json({ data: toPublicInterview(interview) });
}));

// POST /api/employer/interviews/:interviewId/cancel — { cancelReason }.
// A cross-tenant id 404s exactly like a missing record — never 403, which
// would confirm the interview exists in another tenant.
router.post('/interviews/:interviewId/cancel', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const interview = await cancelInterviewForCompanyWithNotice(
    req.employerCompanyId,
    req.params.interviewId,
    req.body?.cancelReason ?? null,
    req.employerUser.employerUserId,
  );
  if (!interview) throw new HttpError(404, 'Interview not found', INTERVIEW_ERROR_CODES.INTERVIEW_NOT_FOUND);
  res.json({ data: toPublicInterview(interview) });
}));

// Post-interview outcome errors → HTTP. Not-found stays 404 (never confirms a
// cross-tenant interview exists); everything else is a 400 with the code.
const OUTCOME_ERROR_STATUS = {
  [INTERVIEW_ERROR_CODES.INTERVIEW_NOT_FOUND]: 404,
};
function throwOutcomeError(code) {
  throw new HttpError(OUTCOME_ERROR_STATUS[code] ?? 400, 'Cannot record interview outcome', code);
}

// POST /api/employer/interviews/:interviewId/complete — { recommendation, feedbackText }.
router.post('/interviews/:interviewId/complete', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const result = await submitInterviewFeedback(req.employerCompanyId, req.params.interviewId, {
    recommendation: req.body?.recommendation,
    feedbackText: req.body?.feedbackText,
    actorUserId: req.employerUser.employerUserId,
  });
  if (result.error) throwOutcomeError(result.error);
  const { interview, ...rest } = result;
  res.json({ data: { interview: toPublicInterview(interview), ...rest } });
}));

// POST /api/employer/interviews/:interviewId/no-show — { note? }.
router.post('/interviews/:interviewId/no-show', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const result = await handleNoShow(req.employerCompanyId, req.params.interviewId, {
    note: req.body?.note,
    actorUserId: req.employerUser.employerUserId,
  });
  if (result.error) throwOutcomeError(result.error);
  const { interview, ...rest } = result;
  res.json({ data: { interview: toPublicInterview(interview), ...rest } });
}));

export default router;
