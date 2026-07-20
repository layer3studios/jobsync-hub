// FILE: src/models/employer/company-invite-model.js
// company_invites collection — pending/settled invitations of a teammate to a
// company (feat/team-invites). Schema + indexes + model helpers land THIS chunk so
// chunk 2 can wire the lifecycle routes without more schema work (D3). No lifecycle
// endpoints exist yet; only the read helpers are used (GET /team/invites).
//
// Founder is never invited — only transferred — so the invite role enum excludes it.
// Tokens are 256-bit hex one-time secrets (R5). Every helper takes explicit ids; the
// service layer owns multi-tenant scoping (findByToken is intentionally global).

import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

export const COMPANY_INVITE_ROLES = ['owner', 'member', 'interviewer'];
export const COMPANY_INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const invitesCol = () => col('company_invites');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** 64-char hex (256-bit) one-time invite token (R5, C10 — built-in crypto only). */
export function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Default expiry (7 days from now) for a fresh pending invite. */
export function defaultInviteExpiry(from = new Date()) {
  return new Date(from.getTime() + INVITE_TTL_MS);
}

/** Idempotent index setup. Called on boot. Three indexes (V8). */
export async function ensureCompanyInviteIndexes() {
  const collection = await invitesCol();
  await collection.createIndex({ token: 1 }, { unique: true, name: 'company_invites_token' });
  // At most one PENDING invite per email per company (partial unique).
  await collection.createIndex(
    { companyId: 1, email: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' }, name: 'company_invites_pending_email' },
  );
  // For the future expiry sweep.
  await collection.createIndex({ status: 1, expiresAt: 1 }, { name: 'company_invites_status_expiresAt' });
}

/**
 * Insert a pending invite. Validates the role enum (founder excluded) + normalizes
 * the email. A duplicate pending invite for the same email/company, or a token
 * collision, surfaces as E11000. Returns the inserted doc.
 */
export async function insertCompanyInvite({
  companyId, email, role,
  canMoveApplicants = false, canArchiveApplicants = false,
  token, invitedByEmployerUserId, expiresAt,
}) {
  const companyOid = toOid(companyId);
  const inviterOid = toOid(invitedByEmployerUserId);
  const normalizedEmail = normalizeEmail(email);
  if (!companyOid) throw new Error('company_invite: companyId is required');
  if (!normalizedEmail) throw new Error('company_invite: a valid email is required');
  if (!COMPANY_INVITE_ROLES.includes(role)) throw new Error(`company_invite: invalid role "${role}"`);
  if (typeof token !== 'string' || token.length < 32) throw new Error('company_invite: a token is required');
  const now = new Date();
  const doc = {
    companyId: companyOid,
    email: normalizedEmail,
    role,
    canMoveApplicants: Boolean(canMoveApplicants),
    canArchiveApplicants: Boolean(canArchiveApplicants),
    token,
    invitedByEmployerUserId: inviterOid,
    status: 'pending',
    expiresAt: expiresAt instanceof Date ? expiresAt : defaultInviteExpiry(now),
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    acceptedByEmployerUserId: null,
  };
  const collection = await invitesCol();
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Look up an invite by its token. Global by design — the service layer scopes. */
export async function findCompanyInviteByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const collection = await invitesCol();
  return collection.findOne({ token });
}

/** Pending invites for one company (excludes accepted/revoked/expired). */
export async function findPendingInvitesByCompanyId(companyId) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const collection = await invitesCol();
  return collection.find({ companyId: companyOid, status: 'pending' }).toArray();
}

/** The single pending invite for (companyId, email), or null. */
export async function findPendingInviteByCompanyAndEmail(companyId, email) {
  const companyOid = toOid(companyId);
  const normalizedEmail = normalizeEmail(email);
  if (!companyOid || !normalizedEmail) return null;
  const collection = await invitesCol();
  return collection.findOne({ companyId: companyOid, email: normalizedEmail, status: 'pending' });
}

/** Flip an invite to revoked. Returns the updated doc, or null when missing. */
export async function markInviteRevoked(inviteId) {
  const oid = toOid(inviteId);
  if (!oid) return null;
  const collection = await invitesCol();
  return collection.findOneAndUpdate(
    { _id: oid },
    { $set: { status: 'revoked', updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Flip an invite to accepted, stamping who/when. Returns the updated doc, or null. */
export async function markInviteAccepted(inviteId, acceptedByEmployerUserId) {
  const oid = toOid(inviteId);
  const acceptorOid = toOid(acceptedByEmployerUserId);
  if (!oid) return null;
  const now = new Date();
  const collection = await invitesCol();
  return collection.findOneAndUpdate(
    { _id: oid },
    { $set: { status: 'accepted', acceptedAt: now, acceptedByEmployerUserId: acceptorOid, updatedAt: now } },
    { returnDocument: 'after' },
  );
}

/** Flip an invite to expired (used by the future sweep). Returns updated doc or null. */
export async function markInviteExpired(inviteId) {
  const oid = toOid(inviteId);
  if (!oid) return null;
  const collection = await invitesCol();
  return collection.findOneAndUpdate(
    { _id: oid },
    { $set: { status: 'expired', updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}
