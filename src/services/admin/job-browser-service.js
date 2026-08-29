// FILE: src/services/admin/job-browser-service.js
// Admin search and moderation over the whole jobs corpus — scraped jobs and
// native employer postings share the `jobs` collection and are told apart by
// `sourceSite` (scraped) vs `source: 'native'` (posting-model).
//
// DELETE IS SCRAPED-ONLY, enforced here rather than in the UI. A native posting
// belongs to the employer who wrote it; the admin panel may hide it from seeker
// surfaces but must never destroy it.
//
// Hiding sets `adminHiddenAt`, which every seeker-facing read in
// src/Db/jobs/queries.js excludes (see NOT_ADMIN_HIDDEN there).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { appendAudit } from '../dpdp/audit-log-service.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';

const JOBS = 'jobs';
const NATIVE = 'native';
const MAX_LIMIT = 200;

const SCRAPED_FILTER = { sourceSite: { $exists: true } };
const NATIVE_FILTER = { source: NATIVE };

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

const isNativeDoc = (doc) => doc?.source === NATIVE || (!doc?.sourceSite && Boolean(doc?.companyId));

/**
 * Scraped jobs use the PascalCase scraper schema (JobTitle/Company); native
 * postings use the posting-model's camelCase (title). One row shape for both.
 */
function toRow(doc) {
  const native = isNativeDoc(doc);
  return {
    id: doc._id.toString(),
    title: doc.JobTitle ?? doc.title ?? null,
    company: doc.Company ?? null,
    isNative: native,
    source: native ? 'native' : 'scraped',
    siteName: doc.sourceSite ?? null,
    location: doc.Location ?? doc.location ?? null,
    status: doc.Status ?? doc.status ?? null,
    postedAt: doc.PostedDate ?? doc.postedAt ?? doc.createdAt ?? null,
    isHidden: Boolean(doc.adminHiddenAt),
    adminHiddenAt: doc.adminHiddenAt ?? null,
    // Stripped by attachCompanyNames once resolved; never sent to the client.
    companyId: doc.companyId ?? null,
  };
}

/**
 * Native postings carry `companyId`, not the scraper's denormalised `Company`,
 * so their company name needs one lookup. Done as a single batched query over
 * the page's ids rather than a $lookup per row.
 */
async function attachCompanyNames(rows) {
  const ids = rows.filter((row) => row.isNative && row.companyId).map((row) => row.companyId);
  if (ids.length === 0) return rows.map(({ companyId, ...row }) => { void companyId; return row; });
  const companies = await col('companies');
  const docs = await companies
    .find({ _id: { $in: ids } }, { projection: { name: 1 } })
    .toArray();
  const nameById = new Map(docs.map((doc) => [doc._id.toString(), doc.name]));
  return rows.map(({ companyId, ...row }) => ({
    ...row,
    company: row.company ?? (companyId ? nameById.get(companyId.toString()) ?? null : null),
  }));
}

/** Build the search filter. Every clause is ANDed. */
export function buildSearchFilter({ q, source = 'all', site, hidden = 'exclude' } = {}) {
  const must = [];

  if (source === 'scraped') must.push(SCRAPED_FILTER);
  else if (source === 'native') must.push(NATIVE_FILTER);

  if (site) must.push({ sourceSite: site });

  // `adminHiddenAt: null` matches missing-or-null, so "exclude" needs no backfill.
  if (hidden === 'exclude') must.push({ adminHiddenAt: null });
  else if (hidden === 'only') must.push({ adminHiddenAt: { $ne: null } });

  const term = typeof q === 'string' ? q.trim() : '';
  if (term.length >= 2) {
    const re = { $regex: escapeRegex(term), $options: 'i' };
    // `title` covers native postings, whose schema has no JobTitle.
    must.push({ $or: [{ JobTitle: re }, { Company: re }, { title: re }] });
  }

  return must.length === 0 ? {} : { $and: must };
}

/** Paginated search across the whole corpus. Returns { jobs, total }. */
export async function searchJobs({ q, source = 'all', site, hidden = 'exclude', limit = 50, skip = 0 } = {}) {
  const jobs = await col(JOBS);
  const filter = buildSearchFilter({ q, source, site, hidden });
  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), MAX_LIMIT);
  const safeSkip = Math.max(0, Number(skip) || 0);

  const [total, docs] = await Promise.all([
    jobs.countDocuments(filter),
    jobs.find(filter, {
      projection: {
        JobTitle: 1, title: 1, Company: 1, sourceSite: 1, source: 1, companyId: 1,
        Location: 1, location: 1, Status: 1, status: 1,
        PostedDate: 1, postedAt: 1, createdAt: 1, adminHiddenAt: 1,
      },
    })
      .sort({ PostedDate: -1, createdAt: -1 })
      .skip(safeSkip)
      .limit(safeLimit)
      .toArray(),
  ]);

  return { jobs: await attachCompanyNames(docs.map(toRow)), total };
}

/** The distinct scraper sites present, for the browser's site filter. */
export async function listSites() {
  const jobs = await col(JOBS);
  const sites = await jobs.distinct('sourceSite', SCRAPED_FILTER);
  return sites.filter(Boolean).sort();
}

/**
 * One job in full. The raw `Description` is dropped when a cleaned version
 * exists — it is bulky ATS HTML and the cleaned copy is what anything renders.
 */
export async function getJob(id) {
  const oid = toOid(id);
  if (!oid) return null;
  const jobs = await col(JOBS);
  const doc = await jobs.findOne({ _id: oid });
  if (!doc) return null;

  const { Description, DescriptionPlain, ...rest } = doc;
  const [row] = await attachCompanyNames([toRow(doc)]);
  return {
    ...rest,
    ...row,
    _id: undefined,
    description: doc.DescriptionCleaned ?? Description ?? null,
    descriptionIsCleaned: Boolean(doc.DescriptionCleaned),
    descriptionPlain: doc.DescriptionCleaned ? undefined : DescriptionPlain ?? null,
  };
}

/** Shared audit write for a moderation action. */
function auditJob(event, doc, adminUserId) {
  return appendAudit({
    event,
    actorType: 'admin', actorId: adminUserId ?? null,
    targetType: 'job', targetId: doc._id,
    metadata: {
      title: doc.JobTitle ?? doc.title ?? null,
      company: doc.Company ?? null,
      siteName: doc.sourceSite ?? null,
      source: isNativeDoc(doc) ? 'native' : 'scraped',
    },
  });
}

/** Set or clear adminHiddenAt, then audit. Returns the updated row. */
async function setHidden(id, adminUserId, hide) {
  const oid = toOid(id);
  if (!oid) return { ok: false, reason: 'invalid_id' };
  const jobs = await col(JOBS);
  const doc = await jobs.findOne({ _id: oid });
  if (!doc) return { ok: false, reason: 'not_found' };

  await jobs.updateOne(
    { _id: oid },
    { $set: { adminHiddenAt: hide ? new Date() : null, adminHiddenBy: hide ? (adminUserId ?? null) : null } },
  );
  await auditJob(hide ? AUDIT_EVENTS.JOB_HIDDEN : AUDIT_EVENTS.JOB_UNHIDDEN, doc, adminUserId);

  const updated = await jobs.findOne({ _id: oid });
  const [row] = await attachCompanyNames([toRow(updated)]);
  return { ok: true, job: row };
}

export const hideJob = (id, adminUserId) => setHidden(id, adminUserId, true);
export const unhideJob = (id, adminUserId) => setHidden(id, adminUserId, false);

/**
 * Delete a SCRAPED job. A native posting is refused here, server-side — the UI
 * hiding the button is a convenience, not the control. The audit entry is
 * written before the delete: it is the only record that will survive it.
 */
export async function deleteScrapedJob(id, adminUserId) {
  const oid = toOid(id);
  if (!oid) return { deleted: false, reason: 'invalid_id' };
  const jobs = await col(JOBS);
  const doc = await jobs.findOne({ _id: oid });
  if (!doc) return { deleted: false, reason: 'not_found' };
  if (isNativeDoc(doc)) return { deleted: false, reason: 'native_posting' };

  await auditJob(AUDIT_EVENTS.JOB_DELETED, doc, adminUserId);
  const result = await jobs.deleteOne({ _id: oid, ...SCRAPED_FILTER });
  if (result.deletedCount === 0) return { deleted: false, reason: 'not_found' };
  return { deleted: true, jobId: oid.toString() };
}

export default searchJobs;
