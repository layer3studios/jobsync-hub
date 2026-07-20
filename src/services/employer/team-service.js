// FILE: src/services/employer/team-service.js
// Read-side service for the team roster + pending invites (feat/team-invites chunk
// 1). Multi-tenant safe by construction: every function takes companyId explicitly
// and re-scopes on it (C8 defensive re-check even though middleware already gated).

import { findCompanyMembersByCompanyId } from '../../models/employer/company-member-model.js';
import { findPendingInvitesByCompanyId } from '../../models/employer/company-invite-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';

/**
 * The company's members, each enriched with the employer_users identity (name,
 * email, picture). Returns [] for a company with no members. Only rows whose
 * companyId matches are returned (the model already scopes; kept explicit here).
 */
export async function getTeamMembersForCompany(companyId) {
  if (!companyId) return [];
  const members = await findCompanyMembersByCompanyId(companyId);
  const enriched = await Promise.all(members.map(async (member) => {
    const user = await getEmployerUserById(member.employerUserId);
    return {
      id: member._id.toString(),
      employerUserId: member.employerUserId.toString(),
      name: user?.name ?? null,
      email: user?.email ?? null,
      picture: user?.picture ?? null,
      role: member.role,
      isFounder: Boolean(member.isFounder),
      canMoveApplicants: Boolean(member.canMoveApplicants),
      canArchiveApplicants: Boolean(member.canArchiveApplicants),
      invitedByEmployerUserId: member.invitedByEmployerUserId
        ? member.invitedByEmployerUserId.toString()
        : null,
      joinedAt: member.joinedAt,
    };
  }));
  return enriched;
}

/**
 * Pending invites for the company, excluding any that have already lapsed
 * (expiresAt < now) — those are treated as absent until a future sweep flips their
 * status to 'expired'. Client-safe projection (no token leaked here).
 */
export async function getPendingInvitesForCompany(companyId) {
  if (!companyId) return [];
  const now = new Date();
  const invites = await findPendingInvitesByCompanyId(companyId);
  return invites
    .filter((invite) => invite.expiresAt instanceof Date && invite.expiresAt > now)
    .map((invite) => ({
      id: invite._id.toString(),
      email: invite.email,
      role: invite.role,
      canMoveApplicants: Boolean(invite.canMoveApplicants),
      canArchiveApplicants: Boolean(invite.canArchiveApplicants),
      invitedByEmployerUserId: invite.invitedByEmployerUserId
        ? invite.invitedByEmployerUserId.toString()
        : null,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    }));
}
