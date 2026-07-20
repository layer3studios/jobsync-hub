// FILE: src/middleware/require-company-role-middleware.js
// Per-company role gate (feat/team-invites chunk 1). Runs AFTER requireEmployer
// (sets req.employerUser.employerUserId) and requireEmployerCompany (sets
// req.employerCompanyId). Looks up the company_members row for that pair, attaches
// req.companyMemberRole + req.companyMemberPermissions, then permits or 403s.
//
// NOT wired into any existing route this chunk (chunk 3 does the wiring). The
// factories are exported + unit-tested so chunk 3 can drop them in.

import { findCompanyMemberByCompanyAndUser } from '../models/employer/company-member-model.js';
import { HttpError } from './error-handler-middleware.js';

// interviewer < member < owner < founder.
const ROLE_RANK = { interviewer: 0, member: 1, owner: 2, founder: 3 };

/** Load the membership row + attach role/permissions; return it, or 403 via next(). */
async function loadMembership(req, next) {
  const companyId = req.employerCompanyId;
  const employerUserId = req.employerUser?.employerUserId;
  if (!companyId || !employerUserId) {
    next(new HttpError(401, 'Unauthorized'));
    return null;
  }
  const membership = await findCompanyMemberByCompanyAndUser(companyId, employerUserId);
  if (!membership) {
    next(new HttpError(403, 'You are not a member of this company', 'COMPANY_MEMBERSHIP_NOT_FOUND'));
    return null;
  }
  req.companyMemberRole = membership.role;
  req.companyMemberPermissions = {
    canMoveApplicants: Boolean(membership.canMoveApplicants),
    canArchiveApplicants: Boolean(membership.canArchiveApplicants),
  };
  return membership;
}

/** Build a middleware that requires the caller's role to rank >= minRole. */
function requireRoleAtLeast(minRole) {
  const minRank = ROLE_RANK[minRole];
  return async function roleGate(req, _res, next) {
    try {
      const membership = await loadMembership(req, next);
      if (!membership) return;
      if (ROLE_RANK[membership.role] < minRank) {
        return next(new HttpError(403, 'Your role does not permit this action', 'INSUFFICIENT_ROLE'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Build a middleware for an interviewer-configurable capability. Founder/Owner/Member
 * always pass (the capability is implicit for them); Interviewer passes only when the
 * named flag is true, else 403 INSUFFICIENT_INTERVIEWER_PERMS.
 */
function requireCapability(flag) {
  return async function capabilityGate(req, _res, next) {
    try {
      const membership = await loadMembership(req, next);
      if (!membership) return;
      if (membership.role !== 'interviewer') return next(); // implicit for member+
      if (req.companyMemberPermissions[flag]) return next();
      return next(new HttpError(403, 'Your interviewer permissions do not allow this action', 'INSUFFICIENT_INTERVIEWER_PERMS'));
    } catch (err) {
      next(err);
    }
  };
}

export const requireFounder = requireRoleAtLeast('founder');
export const requireOwnerOrHigher = requireRoleAtLeast('owner');
export const requireMemberOrHigher = requireRoleAtLeast('member');
export const requireInterviewerOrHigher = requireRoleAtLeast('interviewer');
export const requireCanMoveApplicants = requireCapability('canMoveApplicants');
export const requireCanArchiveApplicants = requireCapability('canArchiveApplicants');
