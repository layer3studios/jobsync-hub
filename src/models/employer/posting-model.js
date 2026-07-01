// FILE: src/models/employer/posting-model.js
// Native postings live in the shared `jobs` collection alongside scraped jobs,
// distinguished by source:'native'. EVERY query here filters on
// { source: 'native', companyId } so scraped jobs (PascalCase schema) are never
// read or mutated, and tenants never see each other's postings (C7, §6.5, R1).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import {
  slugifyPostingTitle, buildPostingSlugCandidate, randomPostingSlugSuffix,
} from './posting-slug-helpers.js';

const NATIVE = 'native';
const postingsCol = () => col('jobs');

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup (additive — partial on source:'native'). Called on boot. */
export async function ensurePostingIndexes() {
  const collection = await postingsCol();
  await collection.createIndex(
    { companyId: 1, slug: 1 },
    { unique: true, partialFilterExpression: { source: NATIVE }, name: 'jobs_companyId_slug_native' },
  );
  await collection.createIndex(
    { companyId: 1, source: 1, status: 1 },
    { partialFilterExpression: { source: NATIVE }, name: 'jobs_companyId_source_status_native' },
  );
}

/** True when a native posting already owns this slug within the company. */
async function isPostingSlugTaken(companyOid, slug) {
  const collection = await postingsCol();
  const existing = await collection.findOne({ source: NATIVE, companyId: companyOid, slug });
  return existing != null;
}

/** Pick a slug not yet taken within this company: base → base-2 … → base-{random}. */
export async function generateUniquePostingSlugForCompany(companyId, title) {
  const companyOid = toOid(companyId);
  const base = slugifyPostingTitle(title);
  if (companyOid && !(await isPostingSlugTaken(companyOid, base))) return base;
  for (let suffixNumber = 2; suffixNumber <= 100; suffixNumber += 1) {
    const candidate = buildPostingSlugCandidate(base, String(suffixNumber));
    if (companyOid && !(await isPostingSlugTaken(companyOid, candidate))) return candidate;
  }
  return buildPostingSlugCandidate(base, randomPostingSlugSuffix());
}

/** Insert a native posting; retries up to 3 times on a slug race (E11000). */
export async function createPostingForCompany(companyId, input, createdByEmployerUserId) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('createPostingForCompany: invalid companyId');
  const collection = await postingsCol();
  const status = input.status || 'active';
  let pendingSlug = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date();
    const slug = pendingSlug || (await generateUniquePostingSlugForCompany(companyOid, input.title));
    const doc = {
      source: NATIVE,
      companyId: companyOid,
      slug,
      title: input.title,
      description: input.description,
      descriptionPlain: input.description,
      location: input.location,
      workplaceType: input.workplaceType,
      employmentType: input.employmentType,
      salaryMin: input.salaryMin ?? null,
      salaryMax: input.salaryMax ?? null,
      salaryCurrency: 'INR',
      status,
      postedAt: status === 'active' ? now : null,
      createdAt: now,
      updatedAt: now,
      createdByEmployerUserId: toOid(createdByEmployerUserId),
    };
    try {
      const result = await collection.insertOne(doc);
      return { ...doc, _id: result.insertedId };
    } catch (err) {
      if (err?.code === 11000) { pendingSlug = null; continue; }
      throw err;
    }
  }
  throw new Error('Could not generate a unique posting slug after retries');
}

/** List a company's native postings, newest first; optional status filter. */
export async function listPostingsForCompany(companyId, { status } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const collection = await postingsCol();
  const query = { source: NATIVE, companyId: companyOid };
  if (status) query.status = status;
  return collection.find(query).sort({ createdAt: -1 }).toArray();
}

/** Fetch one native posting scoped to the company — cross-tenant returns null. */
export async function getPostingForCompany(companyId, postingId) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  if (!companyOid || !postingOid) return null;
  const collection = await postingsCol();
  return collection.findOne({ _id: postingOid, source: NATIVE, companyId: companyOid });
}

/** Fetch an ACTIVE native posting by slug within a company (public apply, R7). */
export async function getActivePostingBySlugForCompany(companyId, slug) {
  const companyOid = toOid(companyId);
  if (!companyOid || typeof slug !== 'string' || !slug) return null;
  const collection = await postingsCol();
  return collection.findOne({ companyId: companyOid, slug, source: NATIVE, status: 'active' });
}

/** List a company's ACTIVE native postings for the public company page. */
export async function listActivePostingsForCompany(companyId) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const collection = await postingsCol();
  return collection.find({ companyId: companyOid, source: NATIVE, status: 'active' })
    .sort({ postedAt: -1 }).toArray();
}

/**
 * $set only the explicit patch keys. When status transitions to 'active' and
 * postedAt is still null, stamp postedAt once (R4). Returns null on a miss.
 */
export async function updatePostingForCompany(companyId, postingId, patch) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  if (!companyOid || !postingOid) return null;
  const current = await getPostingForCompany(companyOid, postingOid);
  if (!current) return null;
  const setOps = { ...patch, updatedAt: new Date() };
  if (patch.status === 'active' && current.postedAt == null) setOps.postedAt = new Date();
  const collection = await postingsCol();
  return collection.findOneAndUpdate(
    { _id: postingOid, source: NATIVE, companyId: companyOid },
    { $set: setOps },
    { returnDocument: 'after' },
  );
}

export function closePostingForCompany(companyId, postingId) {
  return updatePostingForCompany(companyId, postingId, { status: 'closed' });
}

export function reopenPostingForCompany(companyId, postingId) {
  return updatePostingForCompany(companyId, postingId, { status: 'active' });
}

/** Client-safe projection — id as string, no internal owner/source fields. */
export function toPublicPosting(doc) {
  return {
    id: doc._id.toString(),
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    descriptionPlain: doc.descriptionPlain,
    location: doc.location,
    workplaceType: doc.workplaceType,
    employmentType: doc.employmentType,
    salaryMin: doc.salaryMin ?? null,
    salaryMax: doc.salaryMax ?? null,
    salaryCurrency: doc.salaryCurrency,
    status: doc.status,
    postedAt: doc.postedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
