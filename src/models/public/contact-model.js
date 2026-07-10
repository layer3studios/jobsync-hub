// FILE: src/models/public/contact-model.js
// contacts collection — Lever's Contact: one person per company, deduped by email
// (R1/§5.4). Every query is companyId-scoped (§6.5). A candidate applying to three
// jobs at one company = three applications, one contact.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const contactsCol = () => col('contacts');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureContactIndexes() {
  const collection = await contactsCol();
  await collection.createIndex({ companyId: 1, email: 1 }, { unique: true, name: 'contacts_companyId_email' });
}

/** Find the company's contact for this email, or create one. Retries on E11000 race. */
export async function findOrCreateContactForCompany(companyId, { email, fullName, phone, linkedinUrl, location } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('findOrCreateContactForCompany: invalid companyId');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const collection = await contactsCol();

  const existing = await collection.findOne({ companyId: companyOid, email: normalizedEmail });
  if (existing) return { contact: existing, isNew: false };

  const now = new Date();
  const doc = {
    companyId: companyOid, email: normalizedEmail,
    fullName: fullName ?? null, phone: phone ?? null,
    linkedinUrl: linkedinUrl ?? null, location: location ?? null,
    githubUrl: null, portfolioUrl: null,
    firstSeenAt: now, createdAt: now, updatedAt: now,
  };
  try {
    const result = await collection.insertOne(doc);
    return { contact: { ...doc, _id: result.insertedId }, isNew: true };
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await collection.findOne({ companyId: companyOid, email: normalizedEmail });
      if (raced) return { contact: raced, isNew: false };
    }
    throw err;
  }
}

/** Fetch one contact, scoped to the company — cross-tenant lookups return null. */
export async function getContactForCompany(companyId, contactId) {
  const companyOid = toOid(companyId);
  const contactOid = toOid(contactId);
  if (!companyOid || !contactOid) return null;
  const collection = await contactsCol();
  return collection.findOne({ _id: contactOid, companyId: companyOid });
}

/** Client-safe projection — id as string. Contacts predating enrichment lack the new fields. */
export function toPublicContact(doc) {
  return {
    id: doc._id.toString(),
    email: doc.email,
    fullName: doc.fullName ?? null,
    phone: doc.phone ?? null,
    linkedinUrl: doc.linkedinUrl ?? null,
    githubUrl: doc.githubUrl ?? null,
    portfolioUrl: doc.portfolioUrl ?? null,
    location: doc.location ?? null,
    firstSeenAt: doc.firstSeenAt,
  };
}

// ---------------------------------------------------------------------------
// Resume-derived enrichment (T1.1). Values arrive from an LLM, so the model
// re-validates rather than trusting its caller. Merge rule is FILL-NULLS-ONLY:
// a value already on the contact is never overwritten, because a later, leaner
// resume must not erase signal captured from an earlier, richer one (R3).
// ---------------------------------------------------------------------------

const MAXIMUM_LOCATION_CHARACTERS = 200;
/** Enrichable URL fields → the hostname fragment each must contain (null = any host). */
const ENRICHABLE_URL_HOSTS = { linkedinUrl: 'linkedin.com', githubUrl: 'github.com', portfolioUrl: null };
const ENRICHABLE_FIELDS = ['linkedinUrl', 'githubUrl', 'portfolioUrl', 'location'];

/** Trimmed non-empty string, else null — '' and whitespace-only count as missing (C9, R5). */
const trimmedOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** An absolute http(s) URL, optionally host-constrained. Anything else → null (C10, R2). */
function normalizeEnrichmentUrl(value, requiredHostFragment = null) {
  const raw = trimmedOrNull(value);
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (requiredHostFragment && !parsed.hostname.toLowerCase().includes(requiredHostFragment)) return null;
  return raw;
}

/** Trimmed location, truncated to 200 chars (C11). */
function normalizeEnrichmentLocation(value) {
  const raw = trimmedOrNull(value);
  return raw ? raw.slice(0, MAXIMUM_LOCATION_CHARACTERS) : null;
}

/** Normalize one enrichable field by name; unknown fields and bad values → null. */
export function normalizeEnrichmentField(key, value) {
  if (key === 'location') return normalizeEnrichmentLocation(value);
  if (!Object.hasOwn(ENRICHABLE_URL_HOSTS, key)) return null;
  return normalizeEnrichmentUrl(value, ENRICHABLE_URL_HOSTS[key]);
}

/** A field is fillable when it is absent, null, or an empty/whitespace-only string. */
const isFillable = (value) => value === null || value === undefined
  || (typeof value === 'string' && !value.trim());

/**
 * Fill only the contact's missing enrichable fields from `fields` (§6.5 — the
 * write filter carries companyId). Returns the contact unchanged when nothing
 * qualifies, and null when the contact does not exist for this company.
 */
export async function mergeContactEnrichmentForCompany(companyId, contactId, fields = {}) {
  const current = await getContactForCompany(companyId, contactId);
  if (!current) return null;

  const setOperations = {};
  for (const key of ENRICHABLE_FIELDS) {
    const incoming = normalizeEnrichmentField(key, fields?.[key]);
    if (incoming !== null && isFillable(current[key])) setOperations[key] = incoming;
  }
  if (Object.keys(setOperations).length === 0) return current; // no-op: skip the write entirely

  const collection = await contactsCol();
  await collection.updateOne(
    { _id: current._id, companyId: current.companyId },
    { $set: setOperations, $currentDate: { updatedAt: true } },
  );
  return getContactForCompany(companyId, contactId);
}
