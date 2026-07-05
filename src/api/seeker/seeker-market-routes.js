// FILE: src/api/seeker/seeker-market-routes.js
// Read-only seeker market endpoints, mounted at /api/seeker/market behind
// requireSeeker (server.js). Both delegate to userId-scoped services and never
// write. No consent gate here — this reads aggregate pool data plus the
// caller's own already-consented profile (C10).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { getMatchCountForUser } from '../../services/seeker/match-count-service.js';
import { getSalaryBenchmarkForUser } from '../../services/seeker/salary-benchmark-service.js';

const router = Router();

// GET /match-count[?location=…] — live count of postings matching the seeker.
router.get('/match-count', asyncHandler(async (req, res) => {
  const location = typeof req.query.location === 'string' ? req.query.location : null;
  res.json(await getMatchCountForUser(req.user.userId, { location }));
}));

// GET /salary-benchmark — P25/P50/P75 band for the seeker's seniority slice.
router.get('/salary-benchmark', asyncHandler(async (req, res) => {
  res.json(await getSalaryBenchmarkForUser(req.user.userId));
}));

export default router;
