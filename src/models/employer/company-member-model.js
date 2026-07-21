// FILE: src/models/employer/company-member-model.js
// company_members collection — the per-company membership + role row that lifts
// JobMesh from single-owner to multi-teammate (feat/team-invites chunk 1). One row
// per (companyId, employerUserId). Role lives here, never on employer_users, because
// it is per-company. Every helper takes companyId EXPLICITLY (C8 multi-tenant).
//
// Invariants:
//  D1  isFounder === (role === 'founder'). Enforced on every insert/update — the
//      partial unique index below filters on isFounder:true, so the boolean must be
//      truthful or the "one founder per company" guarantee breaks (C11).
//  The DB indexes are ground truth; app checks are a courtesy, not the guard.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

export const COMPANY_MEMBER_ROLES = ['founder', 'owner', 'member', 'interviewer'];

const membersCol = () => col('company_members');

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. Three indexes (V8). */
export async function ensureCompanyMemberIndexes() {
  const collection = await membersCol();
  // One row per user per company.
  await collection.createIndex(
    { companyId: 1, employerUserId: 1 },
    { unique: true, name: 'company_members_companyId_employerUserId' },
  );
  // At most one founder per company (partial unique on the boolean helper — R4/D1).
  await collection.createIndex(
    { companyId: 1, isFounder: 1 },
    { unique: true, partialFilterExpression: { isFounder: true }, name: 'company_members_companyId_founder' },
  );
  // "Which companies is this user a member of."
  await collection.createIndex({ employerUserId: 1 }, { name: 'company_members_employerUserId' });
}

/** True iff the (role, isFounder) pair honours invariant D1. */
function isFounderFlagConsistent(role, isFounder) {
  return isFounder === (role === 'founder');
}

/**
 * Insert a membership row. Enforces the role enum + the founder-flag invariant (D1)
 * before touching the DB. Interviewer permission flags default false and are stored
 * regardless of role (D2). Returns the inserted doc. Throws on invariant violation;
 * a duplicate (companyId,employerUserId) or a second founder surfaces as E11000.
 */
export async function insertCompanyMember({
  companyId, employerUserId, role,
  isFounder = role === 'founder',
  canMoveApplicants = false, canArchiveApplicants = false,
  invitedByEmployerUserId = null, joinedAt,
}) {
  const companyOid = toOid(companyId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !userOid) throw new Error('company_member: companyId and employerUserId are required');
  if (!COMPANY_MEMBER_ROLES.includes(role)) throw new Error(`company_member: invalid role "${role}"`);
  if (!isFounderFlagConsistent(role, isFounder)) {
    throw new Error('company_member: isFounder must equal (role === "founder") (invariant D1)');
  }
  const now = new Date();
  const doc = {
    companyId: companyOid,
    employerUserId: userOid,
    role,
    isFounder,
    canMoveApplicants: Boolean(canMoveApplicants),
    canArchiveApplicants: Boolean(canArchiveApplicants),
    invitedByEmployerUserId: toOid(invitedByEmployerUserId),
    joinedAt: joinedAt instanceof Date ? joinedAt : now,
    updatedAt: now,
  };
  const collection = await membersCol();
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** All members of one company. Cross-tenant safe: filters on companyId. */
export async function findCompanyMembersByCompanyId(companyId) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const collection = await membersCol();
  return collection.find({ companyId: companyOid }).toArray();
}

/** The single membership row for (companyId, employerUserId), or null. */
export async function findCompanyMemberByCompanyAndUser(companyId, employerUserId) {
  const companyOid = toOid(companyId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !userOid) return null;
  const collection = await membersCol();
  return collection.findOne({ companyId: companyOid, employerUserId: userOid });
}

/** The founder row for a company (isFounder:true), or null. */
export async function findFounderForCompany(companyId) {
  const companyOid = toOid(companyId);
  if (!companyOid) return null;
  const collection = await membersCol();
  return collection.findOne({ companyId: companyOid, isFounder: true });
}

/**
 * Change a member's role, keeping isFounder in lockstep (D1). Interviewer permission
 * flags are left untouched (they stay in the doc but are moot for non-interviewers,
 * D2). Returns the updated doc, or null when the pair is missing. Promoting a second
 * user to founder surfaces as E11000 on the partial unique index.
 */
export async function updateCompanyMemberRole(companyId, employerUserId, newRole) {
  const companyOid = toOid(companyId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !userOid) return null;
  if (!COMPANY_MEMBER_ROLES.includes(newRole)) throw new Error(`company_member: invalid role "${newRole}"`);
  const collection = await membersCol();
  return collection.findOneAndUpdate(
    { companyId: companyOid, employerUserId: userOid },
    { $set: { role: newRole, isFounder: newRole === 'founder', updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Toggle the two interviewer permission flags. Returns the updated doc, or null. */
export async function updateCompanyMemberInterviewerPerms(
  companyId, employerUserId, { canMoveApplicants, canArchiveApplicants },
) {
  const companyOid = toOid(companyId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !userOid) return null;
  const collection = await membersCol();
  return collection.findOneAndUpdate(
    { companyId: companyOid, employerUserId: userOid },
    { $set: { canMoveApplicants: Boolean(canMoveApplicants), canArchiveApplicants: Boolean(canArchiveApplicants), updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Remove a membership row. Returns the deletedCount (0 or 1). */
export async function deleteCompanyMember(companyId, employerUserId) {
  const companyOid = toOid(companyId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !userOid) return 0;
  const collection = await membersCol();
  const result = await collection.deleteOne({ companyId: companyOid, employerUserId: userOid });
  return result.deletedCount;
}
