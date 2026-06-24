// FILE: src/models/user/auth.js
// Identity / lookups. Index setup lives here too.

import { usersCol, toOid, normaliseApplied } from './_shared.js';

function slugify(str) {
  return String(str || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Create indexes idempotently. Also backfills appliedCount for legacy users. */
export async function ensureUserIndexes() {
  const col = await usersCol();
  await col.createIndex({ googleId: 1 }, { unique: true, sparse: true });
  await col.createIndex({ slug: 1 }, { unique: true });
  await col.createIndex({ email: 1 }, { sparse: true });
  // Backfill appliedCount for users that never had it (one-time, idempotent).
  await col.updateMany(
    { appliedCount: { $exists: false } },
    [{ $set: { appliedCount: { $size: { $ifNull: ['$appliedJobs', []] } } } }],
  );
}

/** Fetch a user by ObjectId string. Returns null when missing/invalid. */
export async function getUserById(userId) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const user = await col.findOne({ _id: oid });
  if (!user) return null;
  return {
    ...user,
    appliedCount: typeof user.appliedCount === 'number'
      ? user.appliedCount
      : normaliseApplied(user.appliedJobs).length,
  };
}

/**
 * Find a user by Google profile, or create one. Migrates any pre-existing
 * email/name match by linking googleId onto the existing doc.
 */
export async function findOrCreateGoogleUser({ googleId, email, name, picture }) {
  const col = await usersCol();

  let user = await col.findOne({ googleId });
  if (user) return user;

  user = await col.findOne({ $or: [{ email }, { name }] });
  if (user) {
    await col.updateOne(
      { _id: user._id },
      { $set: { googleId, email, name, picture } },
    );
    return { ...user, googleId, email, name, picture };
  }

  const now = new Date();
  const doc = {
    googleId, email, name, picture,
    slug: slugify(name || email),
    createdAt: now,
    lastVisitAt: now,
    appliedJobs: [],
    appliedCount: 0,
    skills: [],
    comeBackTo: [],
    dismissedJobs: [],
    dailyGoal: 5,
  };
  const result = await col.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}
