// FILE: src/models/employer/company-model.js
// companies collection — the first multi-tenant entity. A self-onboarded
// company is claimed by the EmployerUser that created it. Slugs are unique;
// inserts retry on an E11000 race (R1). Every owner-scoped query carries the
// owning user id (§6.5).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { slugify, buildSlugCandidate, randomSlugSuffix } from './company-slug-helpers.js';

export { slugify };

const companiesCol = () => col('companies');

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureCompanyIndexes() {
  const collection = await companiesCol();
  await collection.createIndex({ slug: 1 }, { unique: true, name: 'companies_slug' });
  await collection.createIndex(
    { claimedByEmployerUserId: 1 },
    { sparse: true, name: 'companies_claimedByEmployerUserId' },
  );
}

/** Fetch a company by id. Returns null when missing/invalid. */
export async function getCompanyById(companyId) {
  const oid = toOid(companyId);
  if (!oid) return null;
  const collection = await companiesCol();
  return collection.findOne({ _id: oid });
}

/** Fetch a company by slug. Returns null when missing. */
export async function getCompanyBySlug(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  const collection = await companiesCol();
  return collection.findOne({ slug });
}

/**
 * Pick a slug not yet taken: base, then base-2 … base-100, then base-{random}.
 * The unique index is the real guard against races; this just minimises retries.
 */
export async function generateUniqueCompanySlug(name) {
  const base = slugify(name);
  if (!(await getCompanyBySlug(base))) return base;
  for (let suffixNumber = 2; suffixNumber <= 100; suffixNumber += 1) {
    const candidate = buildSlugCandidate(base, String(suffixNumber));
    if (!(await getCompanyBySlug(candidate))) return candidate;
  }
  return buildSlugCandidate(base, randomSlugSuffix());
}

/**
 * Insert a company claimed by the given user. Generates a unique slug and
 * retries up to 3 times if a concurrent insert wins the slug (E11000).
 */
export async function createCompany(input, claimedByEmployerUserId) {
  const collection = await companiesCol();
  const ownerOid = toOid(claimedByEmployerUserId);
  let pendingSlug = input.slug || null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date();
    const slug = pendingSlug || (await generateUniqueCompanySlug(input.name));
    const doc = {
      slug,
      name: input.name,
      tagline: input.tagline ?? null,
      website: input.website ?? null,
      logoUrl: input.logoUrl ?? null,
      // Where the bytes actually live on disk. Kept separate from logoUrl — which
      // is the PUBLIC read URL — because the careers page is unauthenticated and
      // must never learn a filesystem path. Never projected to any client.
      logoStoragePath: input.logoStoragePath ?? null,
      plan: 'free',
      claimed: true,
      claimedByEmployerUserId: ownerOid,
      retentionDays: Number.isInteger(input.retentionDays) ? input.retentionDays : 365,
      privacyPolicyUrl: input.privacyPolicyUrl ?? null,
      dpoEmail: input.dpoEmail ?? null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const result = await collection.insertOne(doc);
      return { ...doc, _id: result.insertedId };
    } catch (err) {
      if (err?.code === 11000) { pendingSlug = null; continue; }
      throw err;
    }
  }
  throw new Error('Could not generate a unique company slug after retries');
}

/** Update a company, but only if it is claimed by this user (§6.5). */
export async function updateCompanyForOwner(companyId, claimedByEmployerUserId, patch) {
  const companyOid = toOid(companyId);
  const ownerOid = toOid(claimedByEmployerUserId);
  if (!companyOid || !ownerOid) return null;
  const collection = await companiesCol();
  return collection.findOneAndUpdate(
    { _id: companyOid, claimedByEmployerUserId: ownerOid },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Client-safe projection — ids as strings, no internal owner fields (R6). */
export function toPublicCompany(company) {
  return {
    id: company._id.toString(),
    slug: company.slug,
    name: company.name,
    tagline: company.tagline ?? null,
    website: company.website ?? null,
    logoUrl: company.logoUrl ?? null,
    plan: company.plan,
    retentionDays: company.retentionDays,
    privacyPolicyUrl: company.privacyPolicyUrl ?? null,
    dpoEmail: company.dpoEmail ?? null,
    createdAt: company.createdAt,
  };
}
