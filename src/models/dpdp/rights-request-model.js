// FILE: src/models/dpdp/rights-request-model.js
// rights_requests collection — access/correction/erasure/grievance requests from
// Data Principals (DPDP Rule 14). dueBy encodes the 90-day SLA (R4). Every
// user-scoped read carries the owning userId (§6.5).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const rightsCol = () => col('rights_requests');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureRightsRequestIndexes() {
  const collection = await rightsCol();
  await collection.createIndex({ userId: 1, submittedAt: -1 }, { name: 'rights_user' });
  await collection.createIndex({ status: 1, dueBy: 1 }, { name: 'rights_ops_queue' });
}

/** Pure insert. Stamps createdAt/updatedAt. Returns the inserted doc. */
export async function insertRightsRequest(doc) {
  const collection = await rightsCol();
  const now = new Date();
  const full = {
    userId: toOid(doc.userId),
    requestType: doc.requestType,
    contactEmail: doc.contactEmail,
    description: doc.description ?? '',
    status: doc.status,
    submittedAt: doc.submittedAt ?? now,
    dueBy: doc.dueBy,
    fulfilledAt: doc.fulfilledAt ?? null,
    fulfilledByAdminId: toOid(doc.fulfilledByAdminId),
    notes: doc.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
  const result = await collection.insertOne(full);
  return { ...full, _id: result.insertedId };
}

/** All rights requests for a user, newest first. */
export async function listRightsRequestsForUser(userId) {
  const oid = toOid(userId);
  if (!oid) return [];
  const collection = await rightsCol();
  return collection.find({ userId: oid }).sort({ submittedAt: -1 }).toArray();
}

/** Fetch a rights request by id. Returns null when missing/invalid. */
export async function findRightsRequestById(rid) {
  const oid = toOid(rid);
  if (!oid) return null;
  const collection = await rightsCol();
  return collection.findOne({ _id: oid });
}

/**
 * Requests still awaiting fulfilment, oldest-due first — the ops queue this model's
 * rights_ops_queue index exists for. `types` narrows to e.g. erasure only.
 */
export async function listOpenRightsRequests({ types, dueBefore, limit = 200 } = {}) {
  const query = { status: { $in: ['submitted', 'in_progress'] } };
  if (Array.isArray(types) && types.length > 0) query.requestType = { $in: types };
  if (dueBefore instanceof Date) query.dueBy = { $lte: dueBefore };
  const collection = await rightsCol();
  return collection.find(query).sort({ dueBy: 1 }).limit(limit).toArray();
}

/** Move a request to a terminal status. Stamps fulfilledAt when fulfilling. */
export async function markRightsRequestStatus(rid, status, { fulfilledByAdminId, notes } = {}) {
  const oid = toOid(rid);
  if (!oid) return null;
  const set = { status, updatedAt: new Date() };
  if (status === 'fulfilled') set.fulfilledAt = new Date();
  if (fulfilledByAdminId) set.fulfilledByAdminId = toOid(fulfilledByAdminId);
  if (typeof notes === 'string') set.notes = notes;
  const collection = await rightsCol();
  return collection.findOneAndUpdate({ _id: oid }, { $set: set }, { returnDocument: 'after' });
}

/** Client-safe projection. */
export function toPublicRightsRequest(reqDoc) {
  return {
    id: reqDoc._id.toString(),
    requestType: reqDoc.requestType,
    contactEmail: reqDoc.contactEmail,
    description: reqDoc.description,
    status: reqDoc.status,
    submittedAt: reqDoc.submittedAt,
    dueBy: reqDoc.dueBy,
    fulfilledAt: reqDoc.fulfilledAt ?? null,
    createdAt: reqDoc.createdAt,
  };
}
