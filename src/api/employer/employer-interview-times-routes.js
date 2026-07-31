// FILE: src/api/employer/employer-interview-times-routes.js
// Posting-level interview defaults + availability pool. Mounted at
// /api/employer/jobs behind requireEmployer + requireEmployerCompany
// (server.js); requireEmployerPosting tenant-verifies :postingId. Managing the
// pool is member-or-higher; reading it is interviewer-or-higher. All business
// logic lives in the services/models — wiring only.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireEmployerPosting } from '../../middleware/require-employer-posting-middleware.js';
import {
  requireInterviewerOrHigher, requireMemberOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import { updateInterviewDefaults } from '../../services/employer/posting-defaults-service.js';
import {
  addTimesForPosting, removeTimeForPosting, listTimesForPosting,
  countAvailableTimesForPosting, INTERVIEW_TIME_STATUSES,
} from '../../models/interview/interview-time-model.js';
import { INTERVIEW_ERROR_CODES } from '../../models/interview/interview-constants.js';

const router = Router();

/** Body times → validated future Dates, or a 400. */
function parseFutureTimes(rawTimes) {
  if (!Array.isArray(rawTimes) || rawTimes.length === 0) {
    throw new HttpError(400, 'Provide at least one time', INTERVIEW_ERROR_CODES.INVALID_SLOT);
  }
  const now = new Date();
  return rawTimes.map((entry) => {
    const startAtUtc = new Date(entry?.startAtUtc);
    if (Number.isNaN(startAtUtc.getTime()) || startAtUtc <= now) {
      throw new HttpError(400, 'Every time must be a future date', INTERVIEW_ERROR_CODES.INVALID_SLOT);
    }
    return { startAtUtc };
  });
}

// PUT /api/employer/jobs/:postingId/interview-defaults
router.put('/:postingId/interview-defaults', requireMemberOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const posting = await updateInterviewDefaults(req.employerCompanyId, req.posting._id, {
    meetingUrl: body.meetingUrl,
    durationMinutes: body.durationMinutes,
    mode: body.mode,
    locationText: body.locationText,
    timezoneId: body.timezoneId,
  });
  if (!posting) throw new HttpError(404, 'Posting not found', 'POSTING_NOT_FOUND');
  res.json({ data: posting });
}));

// POST /api/employer/jobs/:postingId/interview-times — { times: [{ startAtUtc }] }
router.post('/:postingId/interview-times', requireMemberOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  if (!req.posting.interviewDefaults) {
    throw new HttpError(400, 'Set up interview defaults before adding times', INTERVIEW_ERROR_CODES.NO_INTERVIEW_DEFAULTS);
  }
  const times = parseFutureTimes(req.body?.times);
  const insertedCount = await addTimesForPosting(req.employerCompanyId, req.posting._id, times, req.posting.interviewDefaults);
  res.status(201).json({ data: { insertedCount } });
}));

// DELETE /api/employer/jobs/:postingId/interview-times/:timeId
router.delete('/:postingId/interview-times/:timeId', requireMemberOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const time = await removeTimeForPosting(req.employerCompanyId, req.posting._id, req.params.timeId);
  if (!time) {
    throw new HttpError(409, 'This time is booked or does not exist — cancel the interview instead', INTERVIEW_ERROR_CODES.TIME_ALREADY_BOOKED);
  }
  res.json({ data: time });
}));

// GET /api/employer/jobs/:postingId/interview-times/count
router.get('/:postingId/interview-times/count', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const availableCount = await countAvailableTimesForPosting(req.employerCompanyId, req.posting._id);
  res.json({ data: { availableCount } });
}));

// GET /api/employer/jobs/:postingId/interview-times?status=available&includePast=false
router.get('/:postingId/interview-times', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const statusFilter = Object.values(INTERVIEW_TIME_STATUSES).includes(req.query.status) ? req.query.status : undefined;
  const times = await listTimesForPosting(req.employerCompanyId, req.posting._id, {
    statusFilter,
    includePast: req.query.includePast === 'true',
  });
  res.json({ data: times });
}));

export default router;
