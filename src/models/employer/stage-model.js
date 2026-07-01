// FILE: src/models/employer/stage-model.js
// stages collection — a company's pipeline columns (Lever's Stage). First-class
// records, not enums (SPEC §1 #6). Every query is scoped by companyId (§6.5).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const stagesCol = () => col('stages');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** The pipeline every new company starts with (SPEC §5.2). */
export const DEFAULT_STAGES = Object.freeze([
  Object.freeze({ text: 'Applied', order: 1, isTerminal: false, isDefault: true, terminalType: null }),
  Object.freeze({ text: 'Shortlisted', order: 2, isTerminal: false, isDefault: false, terminalType: null }),
  Object.freeze({ text: 'Interview', order: 3, isTerminal: false, isDefault: false, terminalType: null }),
  Object.freeze({ text: 'Offer', order: 4, isTerminal: false, isDefault: false, terminalType: null }),
  Object.freeze({ text: 'Hired', order: 5, isTerminal: true, isDefault: false, terminalType: 'hired' }),
]);

/** Idempotent index setup. Called on boot. */
export async function ensureStageIndexes() {
  const collection = await stagesCol();
  await collection.createIndex({ companyId: 1, order: 1 }, { name: 'stages_companyId_order' });
}

/** Seed the 5 default stages for a freshly-created company. */
export async function seedDefaultStagesForCompany(companyId) {
  const oid = toOid(companyId);
  if (!oid) throw new Error('seedDefaultStagesForCompany: invalid companyId');
  const collection = await stagesCol();
  const now = new Date();
  const docs = DEFAULT_STAGES.map((stage) => ({
    companyId: oid, ...stage, createdAt: now, updatedAt: now,
  }));
  const result = await collection.insertMany(docs);
  return docs.map((doc, index) => ({ ...doc, _id: result.insertedIds[index] }));
}

/** List a company's stages in pipeline order. */
export async function listStagesForCompany(companyId) {
  const oid = toOid(companyId);
  if (!oid) return [];
  const collection = await stagesCol();
  return collection.find({ companyId: oid }).sort({ order: 1 }).toArray();
}

/** The company's default (initial) stage — where new applications land (R6). */
export async function getDefaultStageForCompany(companyId) {
  const oid = toOid(companyId);
  if (!oid) return null;
  const collection = await stagesCol();
  return collection.findOne({ companyId: oid, isDefault: true });
}

/** Fetch one stage, scoped to the company — cross-tenant lookups return null. */
export async function getStageForCompany(companyId, stageId) {
  const companyOid = toOid(companyId);
  const stageOid = toOid(stageId);
  if (!companyOid || !stageOid) return null;
  const collection = await stagesCol();
  return collection.findOne({ _id: stageOid, companyId: companyOid });
}
