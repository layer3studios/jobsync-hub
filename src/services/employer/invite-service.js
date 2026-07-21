// FILE: src/services/employer/invite-service.js
// Invite lifecycle (feat/team-invites chunk 2): create, revoke, resend, preview,
// accept. Route handlers stay thin — all rules + edge cases live here. Multi-tenant:
// every company-scoped function takes companyId first; findInviteByToken/acceptInvite
// look up by token then use the found companyId (C8 documented exceptions).
//
// Errors are HttpError (status + code); the central errorHandler renders them. The
// one case that needs an extra body field (INVITE_ALREADY_PENDING → existingInviteId)
// attaches it to the error; the POST route surfaces it.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { FRONTEND_URL } from '../../env.js';
import { col } from '../../Db/connection.js';
import { getCompanyById } from '../../models/employer/company-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import { findCompanyMemberByCompanyAndUser, insertCompanyMember } from '../../models/employer/company-member-model.js';
import {
  insertCompanyInvite, findCompanyInviteByToken, findPendingInviteByCompanyAndEmail,
  findCompanyInviteById, revokeCompanyInvite, regenerateInviteToken,
  acceptPendingInviteByToken, markInviteExpired, generateInviteTokenUrlSafe, defaultInviteExpiry,
} from '../../models/employer/company-invite-model.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // C11: same regex as the rest of the codebase
const MAX_EMAIL_LENGTH = 254;
const INVITE_ROLES = ['owner', 'member', 'interviewer']; // founder is transferred, never invited

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const acceptanceUrl = (token) => `${FRONTEND_URL}/employer/invites/${token}`;

async function findEmployerUserByEmail(email) {
  return (await col('employer_users')).findOne({ email: normalizeEmail(email) });
}

/** Effective status: a pending invite past its expiry reads as 'expired' (no sweep yet). */
function effectiveStatus(invite) {
  if (invite.status === 'pending' && invite.expiresAt instanceof Date && invite.expiresAt < new Date()) return 'expired';
  return invite.status;
}

/** Create a pending invite. Returns { invite, acceptanceUrl }. Edge cases E1–E8. */
export async function createInvite({
  companyId, invitedByEmployerUserId, email, role,
  canMoveApplicants = false, canArchiveApplicants = false,
}) {
  const normEmail = normalizeEmail(email);
  if (!normEmail || normEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(normEmail)) {
    throw new HttpError(400, 'A valid email is required', 'INVALID_EMAIL'); // E4
  }
  if (!INVITE_ROLES.includes(role)) throw new HttpError(400, 'Invalid role', 'INVALID_ROLE'); // E6
  const inviter = await getEmployerUserById(invitedByEmployerUserId);
  if (inviter && normalizeEmail(inviter.email) === normEmail) {
    throw new HttpError(400, 'You cannot invite yourself', 'CANNOT_INVITE_SELF'); // E5
  }
  const existingUser = await findEmployerUserByEmail(normEmail); // E2 (this company only; E3 allowed)
  if (existingUser && await findCompanyMemberByCompanyAndUser(companyId, existingUser._id)) {
    throw new HttpError(409, 'This person is already a member of your team', 'ALREADY_MEMBER');
  }
  const isInterviewer = role === 'interviewer'; // E8: flags only meaningful for interviewers
  const token = generateInviteTokenUrlSafe();
  try {
    const invite = await insertCompanyInvite({
      companyId, email: normEmail, role,
      canMoveApplicants: isInterviewer ? Boolean(canMoveApplicants) : false,
      canArchiveApplicants: isInterviewer ? Boolean(canArchiveApplicants) : false,
      token, invitedByEmployerUserId, expiresAt: defaultInviteExpiry(),
    });
    return { invite, acceptanceUrl: acceptanceUrl(token) };
  } catch (err) {
    if (err?.code === 11000) { // E1: partial-unique on pending {companyId,email,status}
      const existing = await findPendingInviteByCompanyAndEmail(companyId, normEmail);
      const conflict = new HttpError(409, 'A pending invite already exists for this email', 'INVITE_ALREADY_PENDING');
      if (existing) conflict.existingInviteId = existing._id.toString();
      throw conflict;
    }
    throw err;
  }
}

/** Revoke a pending/expired invite (idempotent on revoked). Edge cases R1–R3. */
export async function revokeInvite(companyId, inviteId) {
  const existing = await findCompanyInviteById(companyId, inviteId);
  if (!existing) throw new HttpError(404, 'Invite not found', 'INVITE_NOT_FOUND'); // cross-tenant → 404
  if (existing.status === 'revoked') return existing; // R1 idempotent
  if (existing.status === 'accepted') throw new HttpError(409, 'Cannot revoke an accepted invite', 'CANNOT_REVOKE_ACCEPTED'); // R2
  return (await revokeCompanyInvite(companyId, inviteId)) ?? existing; // R3 (pending|expired → revoked)
}

/** Regenerate the token + expiry of a pending invite. Returns { invite, acceptanceUrl }. S1/S2. */
export async function resendInvite(companyId, inviteId) {
  const existing = await findCompanyInviteById(companyId, inviteId);
  if (!existing) throw new HttpError(404, 'Invite not found', 'INVITE_NOT_FOUND');
  const updated = await regenerateInviteToken(companyId, inviteId);
  if (!updated) throw new HttpError(409, 'Only a pending invite can be resent', 'CANNOT_RESEND_NON_PENDING'); // S1
  return { invite: updated, acceptanceUrl: acceptanceUrl(updated.token) };
}

/** Look up an invite by token (+ its company). Not company-scoped by design (C8). */
export async function findInviteByToken(token) {
  const invite = await findCompanyInviteByToken(token);
  if (!invite) return null;
  return { invite, company: await getCompanyById(invite.companyId) };
}

/** Sanitized public preview. Returns { preview } | { gone: status } | null (not found). D3. */
export async function getInvitePreview(token) {
  const found = await findInviteByToken(token);
  if (!found || !found.company) return null;
  const { invite, company } = found;
  const status = effectiveStatus(invite);
  if (status !== 'pending') return { gone: status }; // route → 410 { status }
  const inviter = await getEmployerUserById(invite.invitedByEmployerUserId);
  return {
    preview: {
      companyName: company.name,
      companyId: company._id.toString(),
      role: invite.role,
      canMoveApplicants: Boolean(invite.canMoveApplicants),
      canArchiveApplicants: Boolean(invite.canArchiveApplicants),
      expiresAt: invite.expiresAt,
      status: 'pending',
      invitedByName: inviter?.name ?? null,
    },
  };
}

/** Accept an invite: validate → create the membership → mark accepted. Edge cases A1–A8. */
export async function acceptInvite({ token, acceptingEmployerUserId, acceptingEmployerUserEmail }) {
  const invite = await findCompanyInviteByToken(token);
  if (!invite) throw new HttpError(404, 'Invite not found', 'INVITE_NOT_FOUND'); // A1
  if (invite.status === 'revoked') throw new HttpError(410, 'This invite was revoked', 'INVITE_REVOKED'); // A2
  if (invite.status === 'accepted') throw new HttpError(410, 'This invite was already accepted', 'INVITE_ALREADY_ACCEPTED'); // A4
  if (effectiveStatus(invite) === 'expired') { // A3
    if (invite.status !== 'expired') await markInviteExpired(invite._id);
    throw new HttpError(410, 'This invite has expired', 'INVITE_EXPIRED');
  }
  if (normalizeEmail(acceptingEmployerUserEmail) !== normalizeEmail(invite.email)) {
    throw new HttpError(403, 'This invite was sent to a different email address', 'INVITE_EMAIL_MISMATCH'); // A5
  }
  const existingMember = await findCompanyMemberByCompanyAndUser(invite.companyId, acceptingEmployerUserId);
  if (existingMember) { // A6: mark accepted (clean pending list, D6) but flag already-member
    await acceptPendingInviteByToken(token, acceptingEmployerUserId);
    return { member: existingMember, redirectUrl: '/employer', alreadyMember: true };
  }
  const accepted = await acceptPendingInviteByToken(token, acceptingEmployerUserId); // A8 atomic
  if (!accepted) throw new HttpError(410, 'This invite was already accepted', 'INVITE_ALREADY_ACCEPTED'); // race lost
  const member = await insertCompanyMember({ // A7: no company required to accept; D5 field copy
    companyId: invite.companyId, employerUserId: acceptingEmployerUserId, role: invite.role, isFounder: false,
    canMoveApplicants: invite.canMoveApplicants, canArchiveApplicants: invite.canArchiveApplicants,
    invitedByEmployerUserId: invite.invitedByEmployerUserId, joinedAt: new Date(),
  });
  return { member, redirectUrl: '/employer' };
}
