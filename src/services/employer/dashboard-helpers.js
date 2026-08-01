// FILE: src/services/employer/dashboard-helpers.js
// Shared batch loaders for the dashboard services. Every query is companyId-
// scoped (§6.5) with companyId as the first filter field — the tenant boundary
// and the index prefix. Contacts are batch-loaded by id set, never N+1.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { listStagesForCompany } from '../../models/employer/stage-model.js';

export const NATIVE_SOURCE = 'native';

export function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Batch-load contacts → Map(idString → { name, email }). */
export async function mapContactsById(companyOid, contactIds) {
  const ids = [...new Set(contactIds.filter(Boolean).map(String))].map((id) => new ObjectId(id));
  if (ids.length === 0) return new Map();
  const collection = await col('contacts');
  const docs = await collection
    .find({ companyId: companyOid, _id: { $in: ids } })
    .project({ fullName: 1, email: 1 })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toString(), {
    name: doc.fullName ?? null, email: doc.email ?? null,
  }]));
}

/** Batch-load native posting titles → Map(idString → title). */
export async function mapPostingTitlesById(companyOid, postingIds) {
  const ids = [...new Set(postingIds.filter(Boolean).map(String))].map((id) => new ObjectId(id));
  if (ids.length === 0) return new Map();
  const collection = await col('jobs');
  const docs = await collection
    .find({ companyId: companyOid, source: NATIVE_SOURCE, _id: { $in: ids } })
    .project({ title: 1 })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toString(), doc.title ?? null]));
}

/** The company's stages → Map(idString → stage text). */
export async function mapStageNamesById(companyId) {
  const stages = await listStagesForCompany(companyId);
  return new Map(stages.map((stage) => [stage._id.toString(), stage.text]));
}

/** Stage ids whose stage is "hired" (terminalType or case-insensitive text). */
export async function listHiredStageIds(companyId) {
  const stages = await listStagesForCompany(companyId);
  return stages
    .filter((s) => s.terminalType === 'hired' || String(s.text ?? '').trim().toLowerCase() === 'hired')
    .map((s) => s._id);
}
