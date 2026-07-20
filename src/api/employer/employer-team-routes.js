// FILE: src/api/employer/employer-team-routes.js
// Team roster + invite lifecycle (feat/team-invites chunks 1–2). The default router
// mounts under /api/employer/team behind requireEmployer + requireEmployerCompany;
// companyId always comes from req.employerCompanyId, never the body (multi-tenant).
//
// The ACCEPT endpoint is a SEPARATE export (acceptRouter): the invitee may not yet
// belong to any company, so it must NOT go through requireEmployerCompany (D2/R6).
// server.js mounts it on requireEmployer only.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  requireInterviewerOrHigher, requireOwnerOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import { getTeamMembersForCompany, getPendingInvitesForCompany } from '../../services/employer/team-service.js';
import {
  createInvite, revokeInvite, resendInvite, acceptInvite,
} from '../../services/employer/invite-service.js';

const router = Router();

/** Inviter-facing invite projection. Includes the token only when asked (create/resend). */
function toInviteResponse(invite, { includeToken = false } = {}) {
  return {
    id: invite._id.toString(),
    email: invite.email,
    role: invite.role,
    canMoveApplicants: Boolean(invite.canMoveApplicants),
    canArchiveApplicants: Boolean(invite.canArchiveApplicants),
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    invitedByEmployerUserId: invite.invitedByEmployerUserId ? invite.invitedByEmployerUserId.toString() : null,
    ...(includeToken ? { token: invite.token } : {}),
  };
}

// GET /members — roster, visible to every member (interviewer and up).
router.get('/members', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  res.json({ members: await getTeamMembersForCompany(req.employerCompanyId) });
}));

// GET /invites — pending invites, Founder/Owner only. Never leaks the token.
router.get('/invites', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  res.json({ invites: await getPendingInvitesForCompany(req.employerCompanyId) });
}));

// POST /invites — create a pending invite. Founder/Owner only. Returns the token +
// shareable URL to the inviter (the only place the token is returned via the roster API).
router.post('/invites', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const { email, role, canMoveApplicants, canArchiveApplicants } = req.body || {};
  try {
    const { invite, acceptanceUrl } = await createInvite({
      companyId: req.employerCompanyId, invitedByEmployerUserId: req.employerUser.employerUserId,
      email, role, canMoveApplicants, canArchiveApplicants,
    });
    res.status(201).json({ invite: toInviteResponse(invite, { includeToken: true }), inviteUrl: acceptanceUrl });
  } catch (err) {
    if (err?.code === 'INVITE_ALREADY_PENDING') {
      return res.status(409).json({ error: err.message, code: err.code, existingInviteId: err.existingInviteId });
    }
    throw err;
  }
}));

// DELETE /invites/:inviteId — revoke a pending invite. Founder/Owner only.
router.delete('/invites/:inviteId', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const invite = await revokeInvite(req.employerCompanyId, req.params.inviteId);
  res.json({ invite: toInviteResponse(invite) });
}));

// POST /invites/:inviteId/resend — new token + expiry; the old link dies immediately.
router.post('/invites/:inviteId/resend', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const { invite, acceptanceUrl } = await resendInvite(req.employerCompanyId, req.params.inviteId);
  res.json({
    message: 'Previous link is now invalid.',
    invite: toInviteResponse(invite, { includeToken: true }),
    newInviteUrl: acceptanceUrl,
  });
}));

// Separate router for accept — auth only, NOT company-scoped (see header / D2).
const acceptRouter = Router();
acceptRouter.post('/', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  const result = await acceptInvite({
    token,
    acceptingEmployerUserId: req.employerUser.employerUserId,
    acceptingEmployerUserEmail: req.employerUser.email,
  });
  const member = toMemberResponse(result.member);
  // A6: already a member → 409, but the invite was still marked accepted (D6).
  if (result.alreadyMember) {
    return res.status(409).json({ error: 'You are already a member of this company', code: 'ALREADY_MEMBER', member, redirectUrl: result.redirectUrl });
  }
  res.status(201).json({ member, redirectUrl: result.redirectUrl });
}));

/** Client-safe membership projection for the accept response. */
function toMemberResponse(member) {
  return {
    id: member._id.toString(),
    employerUserId: member.employerUserId.toString(),
    role: member.role,
    isFounder: Boolean(member.isFounder),
    canMoveApplicants: Boolean(member.canMoveApplicants),
    canArchiveApplicants: Boolean(member.canArchiveApplicants),
    joinedAt: member.joinedAt,
  };
}

export { acceptRouter };
export default router;
