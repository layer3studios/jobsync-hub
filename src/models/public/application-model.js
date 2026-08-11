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
  await collection.createIndex({ companyId: 1, jobId: 1, appliedAt: -1 }, { name: 'applications_companyId_jobId_appliedAt' });
  // Reverse lookup from a submission back to its application. Partial on the $type
  // so the explicit nulls most applications carry are never indexed (never sparse:
  // sparse skips MISSING fields, not explicit nulls).
  await collection.createIndex(
    { assignmentSubmissionId: 1 },
    {
      partialFilterExpression: { assignmentSubmissionId: { $type: 'objectId' } },
      name: 'applications_assignmentSubmissionId',
    },
  );
}

/** Experience buckets applied at query time on application.yearsExperience.
 *  Half-open ranges [min, max); staff has no upper bound. */
export const EXPERIENCE_BUCKETS = {
  fresher: { min: 0, max: 1 },
  junior: { min: 1, max: 3 },
  mid: { min: 3, max: 6 },
  senior: { min: 6, max: 10 },
  staff: { min: 10, max: null },
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Advanced filtered list for the employer applicant list. Filtering happens in
 * Mongo via an aggregation; lookups are added only when the corresponding
 * filter is active. Returns raw application docs (lookup fields stripped),
 * sorted appliedAt desc — the controller merges contacts/scores as before.
 *
 * filters: { stageId, archived, experienceBuckets[], skills[] (AND),
 *            locations[] (OR), appliedWithin ('24h'|'7d'|'30d'),
 *            hasResume, hasNotes }
 */
export async function listApplicationsForJobFiltered(companyId, jobId, filters = {}) {
  const companyOid = toOid(companyId);
  const jobOid = toOid(jobId);
  if (!companyOid || !jobOid) return [];

  const match = { companyId: companyOid, jobId: jobOid };
  if (filters.stageId) match.stageId = toOid(filters.stageId);
  if (filters.archived === null || filters.archived === false) match.archived = null;

  if (Array.isArray(filters.experienceBuckets) && filters.experienceBuckets.length > 0) {
    const or = filters.experienceBuckets
      .map((name) => EXPERIENCE_BUCKETS[name])
      .filter(Boolean)
      .map(({ min, max }) => max === null
        ? { yearsExperience: { $gte: min } }
        : { yearsExperience: { $gte: min, $lt: max } });
    if (or.length > 0) match.$or = or;
  }

  if (filters.appliedWithin) {
    const days = { '24h': 1, '7d': 7, '30d': 30 }[filters.appliedWithin];
    if (days) match.appliedAt = { $gte: new Date(Date.now() - days * 86400000) };
  }

  if (filters.hasResume) match.resumeFileId = { $ne: null };

  const pipeline = [{ $match: match }];

  // Skills: AND across selected tags, matched case-insensitively against the
  // AI score's matchedSkills + bonusSkills for this application.
  const skills = (filters.skills ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (skills.length > 0) {
    pipeline.push(
      { $lookup: { from: 'resume_scores', localField: '_id', foreignField: 'applicationId', as: 'scoreDoc' } },
      { $addFields: {
        skillPool: { $map: {
          input: { $concatArrays: [
            { $ifNull: [{ $first: '$scoreDoc.matchedSkills' }, []] },
            { $ifNull: [{ $first: '$scoreDoc.bonusSkills' }, []] },
          ] },
          as: 'skill',
          in: { $toLower: '$$skill' },
        } },
      } },
      { $match: { $expr: { $setIsSubset: [skills, '$skillPool'] } } },
    );
  }

  // Locations: OR across cities, matched against the contact's free-text location.
  const locations = (filters.locations ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (locations.length > 0) {
    pipeline.push(
      { $lookup: { from: 'contacts', localField: 'contactId', foreignField: '_id', as: 'contactDoc' } },
      { $match: { $or: locations.map((city) => ({
        'contactDoc.location': { $regex: `\\b${escapeRegex(city)}\\b`, $options: 'i' },
      })) } },
    );
  }

  if (filters.hasNotes) {
    pipeline.push(
      { $lookup: { from: 'applicant_notes', localField: '_id', foreignField: 'applicationId', as: 'noteDoc' } },
      { $match: { 'noteDoc.0': { $exists: true } } },
    );
  }

  pipeline.push(
    { $sort: { appliedAt: -1 } },
    { $project: { scoreDoc: 0, skillPool: 0, contactDoc: 0, noteDoc: 0 } },
  );

  const collection = await applicationsCol();
  return collection.aggregate(pipeline).toArray();
}

/**
 * Insert an application for a company. Stamps appliedAt + timestamps.
 *
 * Takes an optional { session } so the apply transaction can enrol this write, and
 * honours a caller-supplied data._id. The explicit _id exists because an assignment
 * application and its submission reference each other: both ids are generated
 * before the transaction opens, which resolves the circular reference AND makes a
 * retried callback write the same documents instead of orphaning the first attempt.
 * Existing callers pass neither and behave exactly as before.
 */
export async function createApplicationForCompany(companyId, data, { session } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('createApplicationForCompany: invalid companyId');
  const collection = await applicationsCol();
  const now = new Date();
  const doc = {
    ...(data._id ? { _id: toOid(data._id) } : {}),
    companyId: companyOid,
    jobId: toOid(data.jobId),
    contactId: toOid(data.contactId),
    stageId: toOid(data.stageId),
    archived: null,
    source: data.source ?? 'apply_page',
    sourceDetail: data.sourceDetail ?? null,
    resumeFileId: toOid(data.resumeFileId),
    assignmentSubmissionId: toOid(data.assignmentSubmissionId),
    coverNote: data.coverNote ?? null,
    yearsExperience: data.yearsExperience ?? null,
    // Recruiter-applied labels, drawn from the company's candidate_tags library.
    // Names rather than ids: a tag is the word a recruiter reads, and the library
    // keeps those words canonical (see candidate-tag-model).
    tags: Array.isArray(data.tags) ? data.tags : [],
    appliedAt: now,
    lastStageMovedAt: now,
    consent: {
      dpdpAcceptedAt: data.consent?.dpdpAcceptedAt ?? null,
      futureOpportunitiesConsent: Boolean(data.consent?.futureOpportunitiesConsent),
      // DPDP evidence for flows that collect more than the base application (the
      // assignment path records files, notes and profile links). Added only when
      // supplied, so a plain apply keeps the exact consent shape it always had —
      // this projection is an allowlist, and anything not named here is dropped.
      ...(data.consent?.dataItems ? { dataItems: data.consent.dataItems } : {}),
      ...(data.consent?.noticeVersion ? { noticeVersion: data.consent.noticeVersion } : {}),
    },
    applicantIp: data.applicantIp ?? null,
    userAgent: data.userAgent ?? null,
    referer: data.referer ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await collection.insertOne(doc, { session });
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

/**
 * Count non-archived applications for many jobs in ONE aggregation, keyed by job
 * id string. Used by the postings list, which would otherwise fire a countDocuments
 * per row (N+1). Jobs with no applications are simply absent from the map — callers
 * default to 0 rather than this padding every id.
 *
 * Archived applications are excluded: the list is answering "how many people are
 * waiting on me", and an archived candidate is not.
 */
export async function countApplicationsForJobs(companyId, jobIds) {
  const companyOid = toOid(companyId);
  const jobOids = (jobIds ?? []).map(toOid).filter(Boolean);
  if (!companyOid || jobOids.length === 0) return new Map();
  const collection = await applicationsCol();
  const rows = await collection.aggregate([
    { $match: { companyId: companyOid, jobId: { $in: jobOids }, archived: null } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
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
    tags: doc.tags ?? [],
    appliedAt: doc.appliedAt,
  };
}

/**
 * Replace an application's tag list. Scoped to the company (§6.5) — the names are
 * already validated against the company's library by the caller. Returns the
 * updated doc, or null when the application is missing or belongs to another tenant.
 */
export async function setApplicationTags(companyId, applicationId, tags) {
  const companyOid = toOid(companyId);
  const appOid = toOid(applicationId);
  if (!companyOid || !appOid) return null;
  const collection = await applicationsCol();
  return collection.findOneAndUpdate(
    { _id: appOid, companyId: companyOid },
    { $set: { tags, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}
