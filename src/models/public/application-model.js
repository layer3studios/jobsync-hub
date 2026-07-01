// FILE: src/models/public/application-model.js
// applications collection — one application per (job, contact). Every query is
// companyId-scoped (§6.5). Consent timestamps + request metadata are stored for
// DPDP evidence (R5). Stage lives here; the move history is in stage_changes.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const applicationsCol = () => col('applications');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureApplicationIndexes() {
  const collection = await applicationsCol();
  await collection.createIndex({ companyId: 1, jobId: 1 }, { name: 'applications_companyId_jobId' });
  await collection.createIndex({ contactId: 1 }, { name: 'applications_contactId' });
  await collection.createIndex({ stageId: 1 }, { name: 'applications_stageId' });
}

/** Insert an application for a company. Stamps appliedAt + timestamps. */
export async function createApplicationForCompany(companyId, data) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('createApplicationForCompany: invalid companyId');
  const collection = await applicationsCol();
  const now = new Date();
  const doc = {
    companyId: companyOid,
    jobId: toOid(data.jobId),
    contactId: toOid(data.contactId),
    stageId: toOid(data.stageId),
    archived: null,
    source: data.source ?? 'apply_page',
    sourceDetail: data.sourceDetail ?? null,
    resumeFileId: toOid(data.resumeFileId),
    coverNote: data.coverNote ?? null,
    yearsExperience: data.yearsExperience ?? null,
    appliedAt: now,
    lastStageMovedAt: now,
    consent: {
      dpdpAcceptedAt: data.consent?.dpdpAcceptedAt ?? null,
      futureOpportunitiesConsent: Boolean(data.consent?.futureOpportunitiesConsent),
    },
    applicantIp: data.applicantIp ?? null,
    userAgent: data.userAgent ?? null,
    referer: data.referer ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Fetch one application, scoped to the company. Cross-tenant returns null. */
export async function getApplicationForCompany(companyId, appId) {
  const companyOid = toOid(companyId);
  const appOid = toOid(appId);
  if (!companyOid || !appOid) return null;
  const collection = await applicationsCol();
  return collection.findOne({ _id: appOid, companyId: companyOid });
}

/** List a job's applications for a company, with optional stage/archived filters. */
export async function listApplicationsForJob(companyId, jobId, { stageId, archived } = {}) {
  const companyOid = toOid(companyId);
  const jobOid = toOid(jobId);
  if (!companyOid || !jobOid) return [];
  const query = { companyId: companyOid, jobId: jobOid };
  if (stageId) query.stageId = toOid(stageId);
  if (archived === null || archived === false) query.archived = null;
  const collection = await applicationsCol();
  return collection.find(query).sort({ appliedAt: -1 }).toArray();
}

/** Count applications for a job within a company. */
export async function countApplicationsForJob(companyId, jobId) {
  const companyOid = toOid(companyId);
  const jobOid = toOid(jobId);
  if (!companyOid || !jobOid) return 0;
  const collection = await applicationsCol();
  return collection.countDocuments({ companyId: companyOid, jobId: jobOid });
}

/** Client-safe projection — ids as strings. */
export function toPublicApplication(doc) {
  return {
    id: doc._id.toString(),
    jobId: doc.jobId?.toString() ?? null,
    contactId: doc.contactId?.toString() ?? null,
    stageId: doc.stageId?.toString() ?? null,
    source: doc.source,
    coverNote: doc.coverNote ?? null,
    yearsExperience: doc.yearsExperience ?? null,
    appliedAt: doc.appliedAt,
  };
}
