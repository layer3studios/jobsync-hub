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

/** Store a freshly parsed profile + resume hash + timestamps. */
export async function upsertProfileForUser(userId, parsedProfile, fileHash) {
  const oid = toOid(userId);
  if (!oid) return;
  const col = await usersCol();
  const now = new Date();
  await col.updateOne(
    { _id: oid },
    { $set: { parsedProfile, lastResumeHash: fileHash, profileParsedAt: now, profileUpdatedAt: now } },
  );
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
