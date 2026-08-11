// FILE: src/models/employer/archive-reason-model.js
// archive_reasons collection — a company's rejection/closure categories
// (Lever's Archive Reason). First-class records, scoped by companyId (§6.5).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const archiveReasonsCol = () => col('archive_reasons');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** The reasons every new company starts with (SPEC §5.2). */
export const DEFAULT_ARCHIVE_REASONS = Object.freeze([
  Object.freeze({ text: 'Hired', type: 'hired', status: 'active' }),
  Object.freeze({ text: 'Underqualified', type: 'non-hired', status: 'active' }),
  Object.freeze({ text: 'Culture fit', type: 'non-hired', status: 'active' }),
  Object.freeze({ text: 'Withdrew', type: 'non-hired', status: 'active' }),
  Object.freeze({ text: 'Position filled', type: 'non-hired', status: 'active' }),
  Object.freeze({ text: 'Offer declined', type: 'non-hired', status: 'active' }),
  Object.freeze({ text: 'Timing', type: 'non-hired', status: 'active' }),
]);

/** Idempotent index setup. Called on boot. */
export async function ensureArchiveReasonIndexes() {
  const collection = await archiveReasonsCol();
  await collection.createIndex({ companyId: 1 }, { name: 'archive_reasons_companyId' });
}

/** Seed the 7 default archive reasons for a freshly-created company. */
export async function seedDefaultArchiveReasonsForCompany(companyId) {
  const oid = toOid(companyId);
  if (!oid) throw new Error('seedDefaultArchiveReasonsForCompany: invalid companyId');
  const collection = await archiveReasonsCol();
  const now = new Date();
  const docs = DEFAULT_ARCHIVE_REASONS.map((reason) => ({
    companyId: oid, ...reason, createdAt: now, updatedAt: now,
  }));
  const result = await collection.insertMany(docs);
  return docs.map((doc, index) => ({ ...doc, _id: result.insertedIds[index] }));
}

/** List a company's archive reasons. */
export async function listArchiveReasonsForCompany(companyId) {
  const oid = toOid(companyId);
  if (!oid) return [];
  const collection = await archiveReasonsCol();
  return collection.find({ companyId: oid }).toArray();
}

/**
 * Find a reason by its exact text (case-insensitive) or create it. Exists for the
 * auto-archive task, which needs a "No response" reason to file its work under and
 * must not depend on a company having added one by hand.
 */
export async function findOrCreateArchiveReasonForCompany(companyId, text, type = 'non-hired') {
  const oid = toOid(companyId);
  if (!oid) throw new Error('findOrCreateArchiveReasonForCompany: invalid companyId');
  const collection = await archiveReasonsCol();
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = await collection.findOne({
    companyId: oid, text: { $regex: `^${escaped}$`, $options: 'i' },
  });
  if (existing) return existing;

  const now = new Date();
  const doc = { companyId: oid, text, type, status: 'active', createdAt: now, updatedAt: now };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Fetch one archive reason, scoped to the company — cross-tenant returns null. */
export async function getArchiveReasonForCompany(companyId, archiveReasonId) {
  const companyOid = toOid(companyId);
  const reasonOid = toOid(archiveReasonId);
  if (!companyOid || !reasonOid) return null;
  const collection = await archiveReasonsCol();
  return collection.findOne({ _id: reasonOid, companyId: companyOid });
}
