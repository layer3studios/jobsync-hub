// FILE: src/api/employer/employer-team-routes.js
// Read endpoints for the team roster + pending invites (feat/team-invites chunk 1).
// Mounted under /api/employer/team behind requireEmployer + requireEmployerCompany
// (see server.js). No lifecycle endpoints yet (chunk 2). companyId always comes from
// req.employerCompanyId — never the request body (multi-tenant, C8).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  requireInterviewerOrHigher, requireOwnerOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import { getTeamMembersForCompany, getPendingInvitesForCompany } from '../../services/employer/team-service.js';

const router = Router();

// GET /api/employer/team/members — the full roster. Visible to EVERY member of the
// company (interviewer and up), since seeing who is on the team is not privileged.
router.get('/members', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const members = await getTeamMembersForCompany(req.employerCompanyId);
  res.json({ members });
}));

// GET /api/employer/team/invites — pending invites. Founder/Owner only. Returns an
// empty list this chunk (no invites can exist yet); chunk 2 makes it useful.
router.get('/invites', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const invites = await getPendingInvitesForCompany(req.employerCompanyId);
  res.json({ invites });
}));

export default router;
