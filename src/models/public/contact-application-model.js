// FILE: src/models/public/contact-application-model.js
// "Where else has this person applied?" — reads across the applications collection
// by contactId rather than by jobId, which is the one question application-model
// (organised around one posting's pipeline) never asks.
//
// A contact is already deduped by email per company (contact-model), so every
// application sharing a contactId IS the same person. There is no fuzzy matching
// here and there must never be: the dedupe happened at apply time.
//
// Every query is companyId-scoped (§6.5) — a contact id from another tenant returns
// an empty list, never a leak.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const applicationsCol = () => col('applications');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/**
 * Every OTHER application by this contact within the company, newest first. The
 * current application is excluded by the caller passing its id — so the same
 * candidate viewed from a different posting correctly excludes a different row.
 *
 * One aggregation: posting title and stage name are joined in rather than fetched
 * per row, because a candidate with ten applications would otherwise be twenty
 * round trips.
 */
export async function listOtherApplicationsForContact(companyId, contactId, excludeApplicationId) {
  const companyOid = toOid(companyId);
  const contactOid = toOid(contactId);
  if (!companyOid || !contactOid) return [];

  const match = { companyId: companyOid, contactId: contactOid };
  const excludeOid = toOid(excludeApplicationId);
  if (excludeOid) match._id = { $ne: excludeOid };

  const collection = await applicationsCol();
  return collection.aggregate([
    { $match: match },
    { $sort: { appliedAt: -1 } },
    { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'postingDoc' } },
    { $lookup: { from: 'stages', localField: 'stageId', foreignField: '_id', as: 'stageDoc' } },
    { $project: {
      jobId: 1, stageId: 1, appliedAt: 1, archived: 1,
      postingTitle: { $first: '$postingDoc.title' },
      stageName: { $first: '$stageDoc.text' },
    } },
  ]).toArray();
}

/**
 * How many applications each of these contacts has in the company, keyed by contact
 * id string. Used by the ranked list to mark cross-applicants without an N+1: one
 * grouped read covers the whole page. Contacts with a single application are still
 * returned (count 1) — the caller decides what counts as "cross".
 */
export async function countApplicationsByContact(companyId, contactIds) {
  const companyOid = toOid(companyId);
  const contactOids = [...new Set((contactIds ?? []).map((id) => id?.toString()).filter(Boolean))]
    .map(toOid).filter(Boolean);
  if (!companyOid || contactOids.length === 0) return new Map();

  const collection = await applicationsCol();
  const rows = await collection.aggregate([
    { $match: { companyId: companyOid, contactId: { $in: contactOids } } },
    { $group: { _id: '$contactId', count: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

/** Client-safe projection of one "also applied to" row. */
export function toOtherApplication(doc) {
  return {
    applicationId: doc._id.toString(),
    postingId: doc.jobId?.toString() ?? null,
    postingTitle: doc.postingTitle ?? null,
    stageId: doc.stageId?.toString() ?? null,
    stage: doc.stageName ?? null,
    appliedAt: doc.appliedAt ?? null,
    isArchived: Boolean(doc.archived),
  };
}
