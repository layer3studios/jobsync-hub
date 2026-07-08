// FILE: src/models/seeker/seeker-profile-helpers.js
// parsedProfile storage on the seeker users collection (additive — no new
// collection, C7). Every function is userId-scoped (§6.5). The PDF is never
// stored; only the normalized profile JSON + the file's SHA-256 hash persist.

import { usersCol, toOid } from './seeker-user-shared-helpers.js';

// Fields a seeker may edit via PATCH without re-uploading (D8).
export const PATCHABLE_PROFILE_FIELDS = [
  'fullName', 'email', 'phone', 'currentLocation', 'summary', 'skills',
  'noticePeriod', 'currentCTC', 'expectedCTC', 'languages', 'linkedinUrl',
  'domain', 'subDomain',
];

/** Return the stored parsedProfile for a user, or null. */
export async function getProfileForUser(userId) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { parsedProfile: 1 } });
  return user?.parsedProfile ?? null;
}

// ISO-string a Date/date-like value, or null. Timestamps are surfaced as ISO
// strings so the client can compare them directly to review.reviewedAt (B2).
function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const EMPTY_ENVELOPE = Object.freeze({
  profile: null,
  meta: Object.freeze({ profileParsedAt: null, profileUpdatedAt: null, hasResumeOnFile: false }),
});

/**
 * Read the parsed profile plus display metadata in one projection (FIX-01 B2).
 * Additive: getProfileForUser keeps its exact shape and callers. hasResumeOnFile
 * reflects whether the F1 dedup hash is present — false on legacy docs that
 * predate the hash write.
 */
export async function getProfileEnvelopeForUser(userId) {
  const oid = toOid(userId);
  if (!oid) return EMPTY_ENVELOPE;
  const col = await usersCol();
  const user = await col.findOne(
    { _id: oid },
    { projection: { parsedProfile: 1, profileParsedAt: 1, profileUpdatedAt: 1, lastResumeHash: 1 } },
  );
  if (!user) return EMPTY_ENVELOPE;
  return {
    profile: user.parsedProfile ?? null,
    meta: {
      profileParsedAt: toIsoOrNull(user.profileParsedAt),
      profileUpdatedAt: toIsoOrNull(user.profileUpdatedAt),
      hasResumeOnFile: Boolean(user.lastResumeHash),
    },
  };
}

/**
 * Store a freshly parsed profile + resume hash + timestamps (FIX-02 D1).
 * Returns the driver's write summary so callers (the queue worker) can treat a
 * zero-match write as a loud failure instead of silent data loss (R1, R3).
 * userId may arrive as a hex string (HTTP path) or as an ObjectId (the queue
 * stores userId as an ObjectId); String() normalises both before toOid so the
 * filter always hits the intended doc (R2 — the actual FIX-02 root cause).
 * @returns {Promise<{ matchedCount:number, modifiedCount:number, userIdUsed:string|null }>}
 */
export async function upsertProfileForUser(userId, parsedProfile, fileHash) {
  const oid = toOid(String(userId ?? ''));
  if (!oid) return { matchedCount: 0, modifiedCount: 0, userIdUsed: null };
  const col = await usersCol();
  const now = new Date();
  const result = await col.updateOne(
    { _id: oid },
    { $set: { parsedProfile, lastResumeHash: fileHash, profileParsedAt: now, profileUpdatedAt: now } },
  );
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, userIdUsed: String(oid) };
}

/** Merge a partial patch into the stored profile via dotted $set paths. */
export async function patchProfileForUser(userId, patch) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const setOps = { profileUpdatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    setOps[`parsedProfile.${key}`] = value;
  }
  await col.updateOne({ _id: oid }, { $set: setOps });
  return getProfileForUser(userId);
}

/** Return the stored resumeReview for a user, or null. */
export async function getReviewForUser(userId) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { resumeReview: 1 } });
  return user?.resumeReview ?? null;
}

/** Store a freshly computed review + reviewedAt stamp. Never touches parsedProfile. */
export async function upsertReviewForUser(userId, review) {
  const oid = toOid(userId);
  if (!oid) return;
  const col = await usersCol();
  await col.updateOne(
    { _id: oid },
    { $set: { resumeReview: review, profileReviewedAt: new Date() } },
  );
}

/** Return the SHA-256 hash of the last uploaded resume, or null. */
export async function getResumeHashForUser(userId) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { lastResumeHash: 1 } });
  return user?.lastResumeHash ?? null;
}
