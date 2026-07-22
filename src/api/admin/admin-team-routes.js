// FILE: src/api/admin/admin-team-routes.js
// Admin team CRUD (feat/admin-team-management chunk 1). Mounted at
// /api/admin/team BEHIND requireAdmin (guard lives in server.js — this file
// assumes req.adminUser). Reads are open to every admin; every mutation is
// super_admin-only. Invite delivery is copy-link (D2): the token is returned
// ONLY from POST /invite, never from GET /.

import { Router } from 'express';
import { FRONTEND_URL } from '../../env.js';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  listAdmins, createAdminInvite, deactivateAdmin, reactivateAdmin, updateAdminRole,
} from '../../models/admin/index.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Stable code → HTTP status for guard throws from the model layer.
const CODE_STATUS = {
  NOT_FOUND: 404,
  INVALID_EMAIL: 400,
  INVALID_ROLE: 400,
  EMAIL_ALREADY_ADMIN: 400,
  CANNOT_DEACTIVATE_SELF: 400,
  CANNOT_DEMOTE_SELF: 400,
  CANNOT_REMOVE_LAST_SUPER_ADMIN: 400,
  CANNOT_DEMOTE_LAST_SUPER_ADMIN: 400,
};

function toHttp(err) {
  const status = err?.code ? CODE_STATUS[err.code] : undefined;
  return status ? new HttpError(status, err.message, err.code) : err;
}

/** Mutations are super_admin-only; plain admins are read-only on the team. */
function requireSuperAdmin(req, _res, next) {
  if (req.adminUser?.role !== 'super_admin') {
    return next(new HttpError(403, 'Super admin required', 'NOT_SUPER_ADMIN'));
  }
  next();
}

/** Roster projection. inviteToken is NEVER included here (V6 — no token leaks). */
function toTeamRow(row, emailById) {
  return {
    adminUserId: row._id.toString(),
    email: row.email,
    role: row.role,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt ?? null,
    lastLoginAt: row.lastLoginAt ?? null,
    activatedAt: row.activatedAt ?? null,
    invitedByAdminUserId: row.invitedByAdminUserId ? row.invitedByAdminUserId.toString() : null,
    invitedByEmail: row.invitedByAdminUserId ? emailById.get(row.invitedByAdminUserId.toString()) ?? null : null,
    notes: row.notes ?? null,
  };
}

const router = Router();

// GET / — full roster (active + inactive), any admin. Inviter emails are
// denormalized from the same result set (every inviter is an admin row — no N+1).
router.get('/', asyncHandler(async (_req, res) => {
  const rows = await listAdmins();
  const emailById = new Map(rows.map((row) => [row._id.toString(), row.email]));
  res.json({ admins: rows.map((row) => toTeamRow(row, emailById)) });
}));

// POST /invite — create a pending admin row + copy-link URL. super_admin only.
router.post('/invite', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { email, role } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    throw new HttpError(400, 'A valid email is required', 'INVALID_EMAIL');
  }
  try {
    // audit: admin_invited
    const row = await createAdminInvite({ email, role, invitedByAdminUserId: req.adminUser.adminUserId });
    res.status(201).json({
      invite: {
        adminUserId: row._id.toString(),
        email: row.email,
        role: row.role,
        inviteToken: row.inviteToken,
        inviteExpiresAt: row.inviteExpiresAt,
        inviteUrl: `${FRONTEND_URL}/admin/invites/${row.inviteToken}`,
      },
    });
  } catch (err) { throw toHttp(err); }
}));

// PATCH /:adminUserId/deactivate — soft-deactivate. super_admin only.
router.patch('/:adminUserId/deactivate', requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    // audit: admin_deactivated
    const row = await deactivateAdmin(req.params.adminUserId, req.adminUser.adminUserId);
    res.json({ admin: toTeamRow(row, new Map()) });
  } catch (err) { throw toHttp(err); }
}));

// PATCH /:adminUserId/reactivate — undo a soft-deactivation. super_admin only.
router.patch('/:adminUserId/reactivate', requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    // audit: admin_reactivated
    const row = await reactivateAdmin(req.params.adminUserId);
    res.json({ admin: toTeamRow(row, new Map()) });
  } catch (err) { throw toHttp(err); }
}));

// PATCH /:adminUserId/role — promote/demote. super_admin only.
router.patch('/:adminUserId/role', requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    // audit: admin_role_changed
    const row = await updateAdminRole(req.params.adminUserId, req.body?.role, req.adminUser.adminUserId);
    res.json({ admin: toTeamRow(row, new Map()) });
  } catch (err) { throw toHttp(err); }
}));

export default router;
