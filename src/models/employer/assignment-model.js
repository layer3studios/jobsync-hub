// FILE: src/models/employer/assignment-model.js
// assignments collection — the reusable take-home task a company attaches to its
// native postings. Company-owned, so it lives under models/employer/ and every
// helper takes companyId FIRST and filters on it (§6.5): a cross-tenant id returns
// null, never another company's row and never an existence-revealing error.
// Structural invariants only (ids, enum membership, numeric range); length/URL/
// markdown rules belong to the validators layer.
//
// Usage reads (countJobsUsingAssignment / listJobTitlesUsingAssignment) hit the
// SHARED `jobs` collection and MUST repeat `source: 'native'` in the filter —
// the jobs_assignmentId_native index is partial on it, and without the clause the
// query degrades to a scan across every scraped ATS row.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const NATIVE = 'native';

const assignmentsCol = () => col('assignments');
const jobsCol = () => col('jobs');

/** The file kinds a submission may carry. An empty allowedFileTypes means link-only. */
export const ALLOWED_FILE_TYPES = Object.freeze(['pdf', 'zip', 'md']);

export const MIN_ESTIMATED_HOURS = 1;
export const MAX_ESTIMATED_HOURS = 8;

// listJobTitlesUsingAssignment exists to NAME the blocking postings in a Chunk 2
// error message, not to paginate. A hard cap keeps that read bounded.
const MAX_USAGE_TITLES = 20;

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureAssignmentIndexes() {
  const collection = await assignmentsCol();
  // The list read: a company's assignments, archived ones filtered in or out.
  await collection.createIndex(
    { companyId: 1, archivedAt: 1 },
    { name: 'assignments_companyId_archivedAt' },
  );
}

/**
 * Normalize allowedFileTypes: a non-array becomes [] (link-only), duplicates are
 * dropped, and an unknown type throws rather than being silently discarded — a
 * typo'd type must not quietly become a stricter upload rule than the author meant.
 */
function normalizeAllowedFileTypes(value) {
  if (!Array.isArray(value)) return [];
  const seen = [];
  for (const entry of value) {
    if (!ALLOWED_FILE_TYPES.includes(entry)) {
      throw new Error(`assignment: invalid allowedFileTypes entry "${entry}"`);
    }
    if (!seen.includes(entry)) seen.push(entry);
  }
  return seen;
}

/** Integer within [1,8] or throw. Rejects 2.5 and '2' — no coercion. */
function requireEstimatedHours(value) {
  if (!Number.isInteger(value) || value < MIN_ESTIMATED_HOURS || value > MAX_ESTIMATED_HOURS) {
    throw new Error(
      `assignment: estimatedHours must be an integer between ${MIN_ESTIMATED_HOURS} and ${MAX_ESTIMATED_HOURS}`,
    );
  }
  return value;
}

/**
 * Insert an assignment for a company. Stamps timestamps and an explicit
 * archivedAt: null (shape stability — the index is plain, not sparse, so an
 * explicit null is exactly what the "not archived" read matches on).
 */
export async function insertAssignment({
  companyId, title, publicSummary, descriptionMarkdown, estimatedHours,
  submissionInstructionsMarkdown, allowedFileTypes, createdByEmployerUserId,
}, { session } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('insertAssignment: invalid companyId');
  const now = new Date();
  const doc = {
    companyId: companyOid,
    title: title ?? null,
    publicSummary: publicSummary ?? null,
    descriptionMarkdown: descriptionMarkdown ?? null,
    estimatedHours: requireEstimatedHours(estimatedHours),
    submissionInstructionsMarkdown: submissionInstructionsMarkdown ?? null,
    allowedFileTypes: normalizeAllowedFileTypes(allowedFileTypes),
    createdByEmployerUserId: toOid(createdByEmployerUserId),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const collection = await assignmentsCol();
  const result = await collection.insertOne(doc, { session });
  return { ...doc, _id: result.insertedId };
}

/** A company's assignments, newest first. Archived rows are excluded by default. */
export async function listAssignmentsForCompany(companyId, { includeArchived = false } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const query = { companyId: companyOid };
  if (!includeArchived) query.archivedAt = null;
  const collection = await assignmentsCol();
  return collection.find(query).sort({ createdAt: -1 }).toArray();
}

/**
 * Batch-fetch assignments by id, tenant-scoped and bounded to the given ids
 * (§6.5) — mirrors listResumeScoresForJob. Exists so the public company page can
 * resolve every posting's assignment in ONE query instead of a lookup per job.
 * An empty list returns [] WITHOUT a round trip. Archived rows are included: the
 * caller decides, and the public page must keep rendering a task that was
 * archived after it was attached.
 */
export async function listAssignmentsForIds(companyId, assignmentIds = []) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const assignmentOids = (Array.isArray(assignmentIds) ? assignmentIds : []).map(toOid).filter(Boolean);
  if (assignmentOids.length === 0) return [];
  const collection = await assignmentsCol();
  return collection.find({ companyId: companyOid, _id: { $in: assignmentOids } }).toArray();
}

/** Fetch one assignment scoped to the company — cross-tenant returns null. */
export async function getAssignmentForCompany(companyId, assignmentId) {
  const companyOid = toOid(companyId);
  const assignmentOid = toOid(assignmentId);
  if (!companyOid || !assignmentOid) return null;
  const collection = await assignmentsCol();
  return collection.findOne({ _id: assignmentOid, companyId: companyOid });
}

/**
 * $set the patch keys, bumping updatedAt. _id and companyId are stripped: a patch
 * must never re-home a row into another tenant. allowedFileTypes / estimatedHours
 * are re-validated when present so an update cannot land a shape an insert refuses.
 * Returns the updated doc, or null on a cross-tenant / missing id.
 */
export async function updateAssignmentForCompany(companyId, assignmentId, patch = {}, { session } = {}) {
  const companyOid = toOid(companyId);
  const assignmentOid = toOid(assignmentId);
  if (!companyOid || !assignmentOid) return null;

  const { _id, companyId: _ignoredCompanyId, ...rest } = patch;
  const setOps = { ...rest, updatedAt: new Date() };
  if ('allowedFileTypes' in rest) setOps.allowedFileTypes = normalizeAllowedFileTypes(rest.allowedFileTypes);
  if ('estimatedHours' in rest) setOps.estimatedHours = requireEstimatedHours(rest.estimatedHours);

  const collection = await assignmentsCol();
  return collection.findOneAndUpdate(
    { _id: assignmentOid, companyId: companyOid },
    { $set: setOps },
    { returnDocument: 'after', session },
  );
}

/**
 * Archive an assignment. Idempotent: the filter does NOT require archivedAt:null,
 * so archiving an already-archived row returns it (with a fresh stamp) instead of
 * a confusing null that the caller would read as "not found".
 */
export async function archiveAssignmentForCompany(companyId, assignmentId, { session } = {}) {
  const companyOid = toOid(companyId);
  const assignmentOid = toOid(assignmentId);
  if (!companyOid || !assignmentOid) return null;
  const current = await getAssignmentForCompany(companyOid, assignmentOid);
  if (!current) return null;
  if (current.archivedAt instanceof Date) return current; // already archived — unchanged
  const now = new Date();
  const collection = await assignmentsCol();
  return collection.findOneAndUpdate(
    { _id: assignmentOid, companyId: companyOid },
    { $set: { archivedAt: now, updatedAt: now } },
    { returnDocument: 'after', session },
  );
}

/** Clear archivedAt back to null. Returns the updated doc, or null. */
export async function unarchiveAssignmentForCompany(companyId, assignmentId, { session } = {}) {
  const companyOid = toOid(companyId);
  const assignmentOid = toOid(assignmentId);
  if (!companyOid || !assignmentOid) return null;
  const collection = await assignmentsCol();
  return collection.findOneAndUpdate(
    { _id: assignmentOid, companyId: companyOid },
    { $set: { archivedAt: null, updatedAt: new Date() } },
    { returnDocument: 'after', session },
  );
}

/** How many native postings currently reference this assignment. Read-only. */
export async function countJobsUsingAssignment(companyId, assignmentId) {
  const companyOid = toOid(companyId);
  const assignmentOid = toOid(assignmentId);
  if (!companyOid || !assignmentOid) return 0;
  const collection = await jobsCol();
  return collection.countDocuments({ source: NATIVE, companyId: companyOid, assignmentId: assignmentOid });
}

/**
 * The referencing postings, capped at 20, so Chunk 2's archive-blocked / edit-blocked
 * errors can name them. Read-only — this never mutates a job.
 */
export async function listJobTitlesUsingAssignment(companyId, assignmentId) {
  const companyOid = toOid(companyId);
  const assignmentOid = toOid(assignmentId);
  if (!companyOid || !assignmentOid) return [];
  const collection = await jobsCol();
  const docs = await collection
    .find({ source: NATIVE, companyId: companyOid, assignmentId: assignmentOid })
    .project({ title: 1, status: 1 })
    .limit(MAX_USAGE_TITLES)
    .toArray();
  return docs.map((doc) => ({ id: doc._id.toString(), title: doc.title ?? null, status: doc.status ?? null }));
}

/** Client-safe projection — ids as strings. */
export function toPublicAssignment(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    title: doc.title ?? null,
    publicSummary: doc.publicSummary ?? null,
    descriptionMarkdown: doc.descriptionMarkdown ?? null,
    estimatedHours: doc.estimatedHours ?? null,
    submissionInstructionsMarkdown: doc.submissionInstructionsMarkdown ?? null,
    allowedFileTypes: doc.allowedFileTypes ?? [],
    createdByEmployerUserId: doc.createdByEmployerUserId?.toString() ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    archivedAt: doc.archivedAt ?? null,
  };
}
