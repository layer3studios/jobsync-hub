// FILE: src/models/employer/saved-view-model.js
// employer_saved_views collection — a recruiter's named filter combinations for
// one posting's applicant list. Per-recruiter (scoped by employerUserId), never
// shared across the team. Every query is companyId-scoped (§6.5).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const savedViewsCol = () => col('employer_saved_views');

/** Max saved views per (recruiter, posting). */
export const SAVED_VIEWS_CAP = 10;
export const SAVED_VIEW_NAME_MAX = 60;

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureSavedViewIndexes() {
  const collection = await savedViewsCol();
  await collection.createIndex(
    { companyId: 1, postingId: 1, employerUserId: 1 },
    { name: 'saved_views_company_posting_user' },
  );
}

/** Whitelist the filter payload — only known filter keys, primitives/arrays only. */
export function sanitizeViewFilters(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const out = {};
  const strArray = (v, cap) => Array.isArray(v)
    ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, cap)
    : [];
  if (input.experience !== undefined) out.experience = strArray(input.experience, 5);
  if (input.skills !== undefined) out.skills = strArray(input.skills, 10);
  if (input.locations !== undefined) out.locations = strArray(input.locations, 10);
  if (['24h', '7d', '30d'].includes(input.appliedWithin)) out.appliedWithin = input.appliedWithin;
  if (input.hasResume === true) out.hasResume = true;
  if (input.hasNotes === true) out.hasNotes = true;
  if (typeof input.stageId === 'string' && input.stageId.length <= 40) out.stageId = input.stageId;
  if (input.includeArchived === true) out.includeArchived = true;
  // The ranked table's own two controls. They are part of "the view I was looking
  // at" just as much as the filter chips are, so a saved view restores them too.
  if (typeof input.search === 'string' && input.search.trim()) out.search = input.search.trim().slice(0, 100);
  if (['score', 'date', 'assignment'].includes(input.sort)) out.sort = input.sort;
  return out;
}

export function validateViewName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw Object.assign(new Error('View name is required.'), { statusCode: 400 });
  if (trimmed.length > SAVED_VIEW_NAME_MAX) {
    throw Object.assign(new Error(`View name must be ${SAVED_VIEW_NAME_MAX} characters or fewer.`), { statusCode: 400 });
  }
  return trimmed;
}

/** List this recruiter's views for one posting, newest first. */
export async function listSavedViews(companyId, postingId, employerUserId) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !postingOid || !userOid) return [];
  const collection = await savedViewsCol();
  return collection
    .find({ companyId: companyOid, postingId: postingOid, employerUserId: userOid })
    .sort({ createdAt: -1 })
    .toArray();
}

/** Create a view; enforces the per-recruiter-per-posting cap. */
export async function createSavedView(companyId, postingId, employerUserId, { name, filters }) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  const userOid = toOid(employerUserId);
  if (!companyOid || !postingOid || !userOid) throw new Error('createSavedView: invalid ids');

  const collection = await savedViewsCol();
  const scope = { companyId: companyOid, postingId: postingOid, employerUserId: userOid };
  const count = await collection.countDocuments(scope);
  if (count >= SAVED_VIEWS_CAP) {
    throw Object.assign(
      new Error(`You can keep up to ${SAVED_VIEWS_CAP} saved views per posting. Delete one to save a new view.`),
      { statusCode: 409 },
    );
  }

  const now = new Date();
  const doc = {
    ...scope,
    name: validateViewName(name),
    filters: sanitizeViewFilters(filters),
    createdAt: now,
    updatedAt: now,
  };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Rename and/or replace filters. Scoped to (company, posting, recruiter). */
export async function updateSavedView(companyId, postingId, employerUserId, viewId, { name, filters }) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  const userOid = toOid(employerUserId);
  const viewOid = toOid(viewId);
  if (!companyOid || !postingOid || !userOid || !viewOid) return null;

  const patch = { updatedAt: new Date() };
  if (name !== undefined) patch.name = validateViewName(name);
  if (filters !== undefined) patch.filters = sanitizeViewFilters(filters);

  const collection = await savedViewsCol();
  const result = await collection.findOneAndUpdate(
    { _id: viewOid, companyId: companyOid, postingId: postingOid, employerUserId: userOid },
    { $set: patch },
    { returnDocument: 'after' },
  );
  return result ?? null;
}

/** Delete a view. Returns true when a row was removed. */
export async function deleteSavedView(companyId, postingId, employerUserId, viewId) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  const userOid = toOid(employerUserId);
  const viewOid = toOid(viewId);
  if (!companyOid || !postingOid || !userOid || !viewOid) return false;
  const collection = await savedViewsCol();
  const result = await collection.deleteOne({
    _id: viewOid, companyId: companyOid, postingId: postingOid, employerUserId: userOid,
  });
  return result.deletedCount === 1;
}

/** Client-safe projection — ids as strings, no tenant fields. */
export function toPublicSavedView(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    filters: doc.filters ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
