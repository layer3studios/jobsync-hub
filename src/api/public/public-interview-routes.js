// FILE: src/api/public/public-interview-routes.js
// Public (unauthenticated) candidate booking endpoints, mounted at /api/public.
// The 256-bit booking token in the URL is the only credential. Responses expose
// ONLY what getBookingPageDataByToken / toCandidateInterview produce — never a
// raw interview doc, never companyId/applicationId/contactId/calendarUid/
// bookingToken. Rate-limited per IP, matching public-apply-routes.
//
// NOTE: the in-memory rate-limit store is per-process. This deploy runs PM2 in
// fork mode (single instance); if it ever moves to cluster mode the effective
// limit multiplies by the worker count and needs a shared (Redis) store.

import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  bookInterviewByToken, getBookingPageDataByToken,
} from '../../services/interview/interview-booking-service.js';
import { toCandidateInterview, INTERVIEW_ERROR_CODES } from '../../models/interview/index.js';

const router = Router();
const FIFTEEN_MINUTES_MILLISECONDS = 15 * 60 * 1000;

const bookingPageLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MILLISECONDS, limit: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});
const bookActionLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MILLISECONDS, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many booking attempts. Try again later.' } },
});

const BOOKING_ERROR_STATUS = {
  [INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID]: 404,
  [INTERVIEW_ERROR_CODES.BOOKING_TOKEN_EXPIRED]: 410,
  [INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED]: 409,
  [INTERVIEW_ERROR_CODES.INVALID_SLOT]: 400,
  [INTERVIEW_ERROR_CODES.SLOT_TOO_SOON]: 400,
};

// GET /api/public/interviews/:bookingToken — data for the booking page.
router.get('/interviews/:bookingToken', bookingPageLimiter, asyncHandler(async (req, res) => {
  const pageData = await getBookingPageDataByToken(req.params.bookingToken);
  if (!pageData) {
    return res.status(404).json({ error: { code: INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID, message: 'This booking link is not valid.' } });
  }
  if (pageData.expired) {
    // companyName only — the 404 below stays completely bare so an unknown and
    // a replaced token remain indistinguishable to someone probing.
    return res.status(410).json({
      error: {
        code: INTERVIEW_ERROR_CODES.BOOKING_TOKEN_EXPIRED,
        message: 'This booking link has expired.',
        companyName: pageData.companyName ?? null,
      },
    });
  }
  res.json({ data: pageData });
}));

// POST /api/public/interviews/:bookingToken/book — { slotIndex }.
router.post('/interviews/:bookingToken/book', bookActionLimiter, asyncHandler(async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  const result = await bookInterviewByToken(req.params.bookingToken, slotIndex);
  if (!result.booked) {
    const status = BOOKING_ERROR_STATUS[result.code] ?? 400;
    return res.status(status).json({ error: { code: result.code, message: 'This slot could not be booked.' } });
  }
  res.json({ data: toCandidateInterview(result.interview) });
}));

export default router;
