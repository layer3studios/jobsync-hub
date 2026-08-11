// FILE: src/models/employer/candidate-tag-model.js
// candidate_tags collection — a company's tag LIBRARY. Tags live here as first-class
// rows so "referral" and "Referral" can never both exist: every name is lowercased and
// trimmed before it is written, and a unique (companyId, name) index is the real guard.
// Applications store the tag NAMES (strings), not ids — a name is what a recruiter
// reads, and the library exists to keep those names canonical. Deleting a tag
// therefore has to pull the string off every application that carries it.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const candidateTagsCol = () => col('candidate_tags');

export const TAG_NAME_MAX = 30;
/** Cap on tags applied to one application. */
export const TAGS_PER_APPLICATION_MAX = 10;

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureCandidateTagIndexes() {
  const collection = await candidateTagsCol();
  await collection.createIndex({ companyId: 1 }, { name: 'candidate_tags_companyId' });
  await collection.createIndex(
    { companyId: 1, name: 1 },
    { unique: true, name: 'candidate_tags_companyId_name' },
  );
}

/** Canonical form: trimmed, collapsed whitespace, lowercase. '' when unusable. */
export function normalizeTagName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, TAG_NAME_MAX);
}

/**
 * Create a tag, or return the one that already exists. A duplicate is NOT an error:
 * the UI's "create and apply" flow fires this on every unmatched keystroke-committed
 * name, and two recruiters typing "referral" the same second must converge on one row.
 */
export async function createTag(companyId, name) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('createTag: invalid companyId');
  const normalized = normalizeTagName(name);
  if (!normalized) {
    throw Object.assign(new Error('Tag name is required.'), { statusCode: 400 });
  }

  const collection = await candidateTagsCol();
  const existing = await collection.findOne({ companyId: companyOid, name: normalized });
  if (existing) return { tag: existing, created: false };

  const now = new Date();
  const doc = { companyId: companyOid, name: normalized, createdAt: now, updatedAt: now };
  try {
    const result = await collection.insertOne(doc);
    return { tag: { ...doc, _id: result.insertedId }, created: true };
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await collection.findOne({ companyId: companyOid, name: normalized });
      if (raced) return { tag: raced, created: false };
    }
    throw err;
  }
}

/** The company's tag library, alphabetical. */
export async function listTags(companyId) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const collection = await candidateTagsCol();
  return collection.find({ companyId: companyOid }).sort({ name: 1 }).toArray();
}

/**
 * Delete a tag and pull its name off every application in the company. Order
 * matters: the $pull runs FIRST, so a crash between the two writes leaves a
 * library row nothing references (harmless) rather than a name on applications
 * that no longer resolves to anything (an orphan the UI would render forever).
 */
export async function deleteTag(companyId, tagId) {
  const companyOid = toOid(companyId);
  const tagOid = toOid(tagId);
  if (!companyOid || !tagOid) return { deleted: false, applicationsUpdated: 0 };

  const collection = await candidateTagsCol();
  const tag = await collection.findOne({ _id: tagOid, companyId: companyOid });
  if (!tag) return { deleted: false, applicationsUpdated: 0 };

  const applications = await col('applications');
  const pulled = await applications.updateMany(
    { companyId: companyOid, tags: tag.name },
    { $pull: { tags: tag.name }, $set: { updatedAt: new Date() } },
  );
  await collection.deleteOne({ _id: tag._id, companyId: companyOid });
  return { deleted: true, applicationsUpdated: pulled.modifiedCount };
}

/**
 * Validate a caller-supplied tag list against the company's library. Returns the
 * canonical names, deduped and capped. Any name not in the library is refused —
 * the library is the whole point, and silently creating rows here would let the
 * PUT endpoint become a second, unaudited way to grow it.
 */
export async function resolveTagNames(companyId, input) {
  if (!Array.isArray(input)) {
    throw Object.assign(new Error('tags must be an array of tag names.'), { statusCode: 400 });
  }
  const names = [...new Set(input.map(normalizeTagName).filter(Boolean))];
  if (names.length > TAGS_PER_APPLICATION_MAX) {
    throw Object.assign(
      new Error(`A candidate can carry up to ${TAGS_PER_APPLICATION_MAX} tags.`),
      { statusCode: 400 },
    );
  }
  if (names.length === 0) return [];

  const library = await listTags(companyId);
  const known = new Set(library.map((tag) => tag.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw Object.assign(
      new Error(`Unknown tag: ${unknown.join(', ')}. Create it first.`),
      { statusCode: 400 },
    );
  }
  return names;
}

/** Client-safe projection — id as string, no tenant fields. */
export function toPublicTag(doc) {
  return { id: doc._id.toString(), name: doc.name, createdAt: doc.createdAt };
}
