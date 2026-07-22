// FILE: src/models/admin/admin-team-helpers.js
// Team-management queries for admin_users (feat/admin-team-management chunk 1).
// Extracted from admin-user-model.js to honour the 200-line cap (C1), mirroring
// the seeker slug-helpers split. Invite tokens follow company-invite-model:
// 32-byte hex, 7-day expiry, single-use. Every guard throws an Error with a
// stable `code` the route layer maps to an HTTP status.

import crypto from 'node:crypto';
import { col } from '../../Db/connection.js';
import { EMAIL_COLLATION, normalizeEmail, toOid } from './admin-user-model.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, mirrors company invites (R2)
const ROLES = ['super_admin', 'admin'];

const adminUsersCol = () => col('admin_users');
const teamError = (code, message) => Object.assign(new Error(message), { code });

/** All admin rows (active AND inactive), newest first. */
export async function listAdmins() {
  const collection = await adminUsersCol();
  return collection.find({}).sort({ createdAt: -1 }).toArray();
}

/** Pending-invite row for a live token: unexpired AND still inactive. Else null. */
export async function findAdminByInviteToken(token) {
  if (typeof token !== 'string' || token === '') return null;
  const collection = await adminUsersCol();
  return collection.findOne({
    inviteToken: token, inviteExpiresAt: { $gt: new Date() }, isActive: false,
  });
}

/**
 * Create (or refresh) a pending invite. Active email → EMAIL_ALREADY_ADMIN.
 * Existing INACTIVE row → overwrite token/expiry/role/invitedBy in place (D4 —
 * preserves createdAt). New email → insert a pending row. Returns the full row
 * including the token (the ONLY place the token leaves the model layer).
 */
export async function createAdminInvite({ email, role, invitedByAdminUserId } = {}) {
  const lowered = normalizeEmail(email);
  if (!lowered) throw teamError('INVALID_EMAIL', 'A valid email is required');
  if (!ROLES.includes(role)) throw teamError('INVALID_ROLE', 'Role must be super_admin or admin');

  const collection = await adminUsersCol();
  const existing = await collection.findOne({ email: lowered }, { collation: EMAIL_COLLATION });
  if (existing?.isActive) throw teamError('EMAIL_ALREADY_ADMIN', 'Email is already an active admin');

  const now = new Date();
  const inviteFields = {
    inviteToken: crypto.randomBytes(32).toString('hex'), // R1: 64-char hex
    inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    invitedByAdminUserId: toOid(invitedByAdminUserId),
    role,
  };

  if (existing) {
    await collection.updateOne({ _id: existing._id }, { $set: inviteFields }); // audit: admin_invited
    return collection.findOne({ _id: existing._id });
  }
  const doc = {
    email: lowered, ...inviteFields, isActive: false,
    createdAt: now, lastLoginAt: null, activatedAt: null, notes: null,
  };
  const { insertedId } = await collection.insertOne(doc); // audit: admin_invited
  return { _id: insertedId, ...doc };
}

/**
 * Single-use activation: valid token + matching verified Google email flips the
 * row active and consumes the token. Token fields are $unset (NOT set to null) so
 * the sparse unique index never sees two cleared rows collide.
 */
export async function activateAdminByInviteToken(token, verifiedEmail) {
  const row = await findAdminByInviteToken(token);
  if (!row) throw teamError('INVITE_INVALID', 'Invite invalid or expired');
  if (row.email !== normalizeEmail(verifiedEmail)) {
    throw teamError('INVITE_EMAIL_MISMATCH', 'Invite email does not match your Google account');
  }
  const collection = await adminUsersCol();
  const now = new Date();
  await collection.updateOne(
    { _id: row._id },
    { $set: { isActive: true, activatedAt: now, lastLoginAt: now }, $unset: { inviteToken: '', inviteExpiresAt: '' } },
  ); // audit: admin_invite_accepted
  return collection.findOne({ _id: row._id });
}

/** Active super_admin count — the "last super admin" guard (R5: benign race at 2-3 admin scale). */
async function countActiveSuperAdmins(collection) {
  return collection.countDocuments({ role: 'super_admin', isActive: true });
}

/** Soft-deactivate. Never deletes (audit trail). Self + last-super guards. */
export async function deactivateAdmin(adminUserId, actingSuperAdminId) {
  if (String(adminUserId) === String(actingSuperAdminId)) {
    throw teamError('CANNOT_DEACTIVATE_SELF', 'Cannot deactivate yourself');
  }
  const oid = toOid(adminUserId);
  const collection = await adminUsersCol();
  const target = oid ? await collection.findOne({ _id: oid }) : null;
  if (!target) throw teamError('NOT_FOUND', 'Admin not found');
  if (target.role === 'super_admin' && target.isActive && (await countActiveSuperAdmins(collection)) <= 1) {
    throw teamError('CANNOT_REMOVE_LAST_SUPER_ADMIN', 'Cannot deactivate the last super admin');
  }
  await collection.updateOne({ _id: oid }, { $set: { isActive: false } }); // audit: admin_deactivated
  return collection.findOne({ _id: oid });
}

/** Reactivate a soft-deactivated admin. Route layer restricts to super_admin. */
export async function reactivateAdmin(adminUserId) {
  const oid = toOid(adminUserId);
  const collection = await adminUsersCol();
  const target = oid ? await collection.findOne({ _id: oid }) : null;
  if (!target) throw teamError('NOT_FOUND', 'Admin not found');
  await collection.updateOne({ _id: oid }, { $set: { isActive: true } }); // audit: admin_reactivated
  return collection.findOne({ _id: oid });
}

/** Change role. Self-demotion + last-super-demotion guards. */
export async function updateAdminRole(adminUserId, newRole, actingSuperAdminId) {
  if (!ROLES.includes(newRole)) throw teamError('INVALID_ROLE', 'Role must be super_admin or admin');
  if (String(adminUserId) === String(actingSuperAdminId) && newRole !== 'super_admin') {
    throw teamError('CANNOT_DEMOTE_SELF', 'Cannot demote yourself');
  }
  const oid = toOid(adminUserId);
  const collection = await adminUsersCol();
  const target = oid ? await collection.findOne({ _id: oid }) : null;
  if (!target) throw teamError('NOT_FOUND', 'Admin not found');
  if (
    target.role === 'super_admin' && target.isActive && newRole !== 'super_admin'
    && (await countActiveSuperAdmins(collection)) <= 1
  ) {
    throw teamError('CANNOT_DEMOTE_LAST_SUPER_ADMIN', 'Cannot demote the last super admin');
  }
  await collection.updateOne({ _id: oid }, { $set: { role: newRole } }); // audit: admin_role_changed
  return collection.findOne({ _id: oid });
}
