// FILE: src/services/employer/member-management-service.js
// Member management (feat/team-invites chunk 3): change role / interviewer flags,
// remove a member, transfer Founder. Multi-tenant: companyId is the first argument
// and scopes every query; a :memberId that belongs to another company reads as 404.
//
// The company_members schema is frozen (Chunk 1), and its model helpers are keyed by
// employerUserId, so these by-_id, guard-scoped operations query the collection
// directly here. Each single-doc update is atomic via findOneAndUpdate/deleteOne with
// the guards in the filter (R2). transferFounder is two writes → compensating-write
// pattern with rollback (the driver is a bare MongoClient with no guaranteed
// replica-set/transaction support; a standalone mongod would reject a transaction).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';

const ROLE_RANK = { interviewer: 0, member: 1, owner: 2, founder: 3 };
const PATCHABLE_ROLES = ['owner', 'member', 'interviewer']; // 'founder' is set only via transfer
const membersCol = () => col('company_members');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}
const notFound = () => new HttpError(404, 'Member not found', 'MEMBER_NOT_FOUND');
const sameUser = (a, b) => a && b && a.toString() === b.toString();

/** Change a member's role and/or interviewer flags. Owner+ (gated at the route). */
export async function patchMember(companyId, memberId, patch, { actorEmployerUserId }) {
  const companyOid = toOid(companyId);
  const memberOid = toOid(memberId);
  if (!companyOid || !memberOid) throw notFound();
  const collection = await membersCol();
  const target = await collection.findOne({ _id: memberOid, companyId: companyOid });
  if (!target) throw notFound(); // cross-tenant → 404 (R5)
  if (sameUser(target.employerUserId, toOid(actorEmployerUserId))) {
    throw new HttpError(400, 'You cannot change your own role', 'SELF_ROLE_CHANGE_FORBIDDEN'); // D2
  }
  if (target.isFounder) {
    throw new HttpError(403, 'Cannot change the Founder\'s role; transfer Founder instead', 'CANNOT_PATCH_FOUNDER');
  }
  const set = { updatedAt: new Date() };
  if (patch.role !== undefined) {
    if (!PATCHABLE_ROLES.includes(patch.role)) throw new HttpError(400, 'Invalid role', 'INVALID_ROLE');
    set.role = patch.role;
    set.isFounder = false;
  }
  const effectiveRole = set.role ?? target.role;
  const isInterviewer = effectiveRole === 'interviewer'; // D5: flags only meaningful for interviewers
  if (patch.canMoveApplicants !== undefined) set.canMoveApplicants = isInterviewer ? Boolean(patch.canMoveApplicants) : false;
  if (patch.canArchiveApplicants !== undefined) set.canArchiveApplicants = isInterviewer ? Boolean(patch.canArchiveApplicants) : false;

  const updated = await collection.findOneAndUpdate(
    { _id: memberOid, companyId: companyOid, isFounder: false },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) throw notFound();
  return updated;
}

/** Remove a member. Owner+ removes others; anyone (non-Founder) may remove themselves (D3). */
export async function removeMember(companyId, memberId, { actorRole, actorEmployerUserId }) {
  const companyOid = toOid(companyId);
  const memberOid = toOid(memberId);
  if (!companyOid || !memberOid) throw notFound();
  const collection = await membersCol();
  const target = await collection.findOne({ _id: memberOid, companyId: companyOid });
  if (!target) throw notFound();
  const isSelf = sameUser(target.employerUserId, toOid(actorEmployerUserId));
  if (target.isFounder) { // Founder is the ultimate safeguard — never removable here (D4)
    throw isSelf
      ? new HttpError(403, 'The Founder cannot remove themselves; transfer Founder first', 'CANNOT_REMOVE_SELF_FOUNDER')
      : new HttpError(403, 'Cannot remove the Founder; transfer Founder first', 'CANNOT_REMOVE_FOUNDER');
  }
  if (!isSelf && ROLE_RANK[actorRole] < ROLE_RANK.owner) {
    throw new HttpError(403, 'Only an Owner or Founder can remove other members', 'INSUFFICIENT_ROLE');
  }
  const result = await collection.deleteOne({ _id: memberOid, companyId: companyOid, isFounder: false });
  if (result.deletedCount === 0) throw notFound();
  return { removed: true, memberId: memberOid.toString() };
}

/**
 * Transfer Founder from the current Founder (the actor) to an existing Owner. Two
 * writes with rollback (D1): (a) demote current Founder → Owner, (b) promote target →
 * Founder; if (b) fails, restore (a). `deps.promote` is injectable so a test can force
 * the second-write failure and assert the state converges back to the original.
 */
export async function transferFounder(companyId, toMemberId, { actorEmployerUserId }, deps = {}) {
  const companyOid = toOid(companyId);
  const targetOid = toOid(toMemberId);
  if (!companyOid || !targetOid) throw notFound();
  const collection = await membersCol();
  const founder = await collection.findOne({ companyId: companyOid, isFounder: true });
  if (!founder || !sameUser(founder.employerUserId, toOid(actorEmployerUserId))) {
    throw new HttpError(403, 'Only the current Founder can transfer Founder status', 'NOT_FOUNDER');
  }
  const target = await collection.findOne({ _id: targetOid, companyId: companyOid });
  if (!target) throw notFound();
  if (target._id.equals(founder._id)) throw new HttpError(400, 'You are already the Founder', 'CANNOT_TRANSFER_TO_SELF');
  if (!(target.role === 'owner' && !target.isFounder)) {
    throw new HttpError(400, 'The target must be an existing Owner', 'TARGET_NOT_OWNER');
  }
  const promote = deps.promote ?? ((id) => collection.updateOne(
    { _id: id, companyId: companyOid }, { $set: { role: 'owner', isFounder: true, updatedAt: new Date() } },
  ));
  // (a) demote the current Founder so the partial-unique index has room for the new one.
  await collection.updateOne({ _id: founder._id }, { $set: { role: 'owner', isFounder: false, updatedAt: new Date() } });
  try {
    await promote(target._id); // (b) promote the target
  } catch (err) {
    // (c) rollback: restore the original Founder.
    await collection.updateOne({ _id: founder._id }, { $set: { role: 'owner', isFounder: true, updatedAt: new Date() } });
    throw new HttpError(500, 'Founder transfer failed and was rolled back', 'TRANSFER_FAILED');
  }
  return { fromMemberId: founder._id.toString(), toMemberId: target._id.toString() };
}
