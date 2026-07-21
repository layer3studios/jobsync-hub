// FILE: src/models/admin/admin-user-model.js
// Admin identity. Third audience alongside seeker (users) and employer
// (employer_users): a separate collection + separate cookie (jm_admin_token) +
// separate middleware (requireAdmin). Native mongodb driver, mirrors
// employer-user-model.js. Admin is NOT a seeker with a flag — GET /api/seeker/me
// never returns isAdmin. The `role` field ('super_admin' | 'admin') exists for a
// future role hierarchy; requireAdmin only checks isActive this chunk.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const EMAIL_COLLATION = { locale: 'en', strength: 2 };

const adminUsersCol = () => col('admin_users');

/** Lowercase + trim an email; returns '' for null/undefined/non-string input. */
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. Unique email, case-insensitive. */
export async function ensureAdminUserIndexes() {
  const collection = await adminUsersCol();
  await collection.createIndex(
    { email: 1 },
    { unique: true, collation: EMAIL_COLLATION, name: 'admin_users_email' },
  );
}

/**
 * Look up an ACTIVE admin by email, case-insensitively (collation strength 2).
 * Returns the row when isActive:true, else null (missing OR deactivated).
 */
export async function findAdminByEmail(email) {
  const lowered = normalizeEmail(email);
  if (!lowered) return null;
  const collection = await adminUsersCol();
  return collection.findOne({ email: lowered, isActive: true }, { collation: EMAIL_COLLATION });
}

/**
 * Look up an ACTIVE admin by id (accepts string or ObjectId). Returns the row
 * when isActive:true, else null (unknown id OR deactivated).
 */
export async function findAdminById(adminUserIdOrString) {
  const oid = toOid(adminUserIdOrString);
  if (!oid) return null;
  const collection = await adminUsersCol();
  return collection.findOne({ _id: oid, isActive: true });
}

/**
 * Idempotent upsert keyed on email. On INSERT: sets createdAt, isActive:true,
 * lastLoginAt:null, and role (default 'admin'), notes, invitedByAdminUserId.
 * On UPDATE: never touches createdAt / lastLoginAt / isActive; writes
 * role / notes / invitedByAdminUserId ONLY when the caller provides them.
 * Returns the resulting row.
 */
export async function upsertAdminByEmail({ email, role, notes, invitedByAdminUserId } = {}) {
  const lowered = normalizeEmail(email);
  if (!lowered) throw new Error('upsertAdminByEmail: email is required');
  const collection = await adminUsersCol();
  const now = new Date();

  const setOnInsert = { email: lowered, createdAt: now, isActive: true, lastLoginAt: null };
  const set = {};
  // A field lives in $set (insert+update) when provided, else defaults via
  // $setOnInsert (insert-only) — so updates never overwrite an unspecified value.
  if (role !== undefined) set.role = role; else setOnInsert.role = 'admin';
  if (notes !== undefined) set.notes = notes; else setOnInsert.notes = null;
  if (invitedByAdminUserId !== undefined) set.invitedByAdminUserId = invitedByAdminUserId;
  else setOnInsert.invitedByAdminUserId = null;

  const update = { $setOnInsert: setOnInsert };
  if (Object.keys(set).length > 0) update.$set = set;

  await collection.updateOne({ email: lowered }, update, { upsert: true, collation: EMAIL_COLLATION });
  return collection.findOne({ email: lowered }, { collation: EMAIL_COLLATION });
}

/** Stamp lastLoginAt = now on a successful admin login. */
export async function markAdminLoggedIn(adminUserId) {
  const oid = toOid(adminUserId);
  if (!oid) return null;
  const collection = await adminUsersCol();
  return collection.updateOne({ _id: oid }, { $set: { lastLoginAt: new Date() } });
}
