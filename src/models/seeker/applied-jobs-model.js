// FILE: src/models/user/applied.js
// Applied-jobs list, stages, and enriched details.

import { ObjectId } from 'mongodb';
import { connectToDb } from '../../Db/connection.js';
import { usersCol, toOid, normaliseApplied, VALID_STAGES } from './_shared.js';

/** Return the user's applied jobs array (normalised). */
export async function getAppliedJobs(userId) {
  const oid = toOid(userId);
  if (!oid) return [];
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { appliedJobs: 1, _id: 0 } });
  return user ? normaliseApplied(user.appliedJobs) : [];
}

/**
 * Return applied jobs enriched with live JobTitle/Company/etc.
 * Sorted newest-first, capped at 50.
 */
export async function getAppliedJobDetails(userId) {
  const oid = toOid(userId);
  if (!oid) return [];
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { appliedJobs: 1, _id: 0 } });
  if (!user) return [];

  const applied = normaliseApplied(user.appliedJobs)
    .sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime())
    .slice(0, 50);

  const db = await connectToDb();
  const validIds = applied
    .map(e => e.jobId)
    .filter(j => ObjectId.isValid(j))
    .map(j => new ObjectId(j));

  const liveJobs = validIds.length > 0
    ? await db.collection('jobs').find(
        { _id: { $in: validIds } },
        { projection: { JobTitle: 1, Company: 1, ApplicationURL: 1, DirectApplyURL: 1, Location: 1, Department: 1 } },
      ).toArray()
    : [];

  const jobMap = new Map(liveJobs.map(j => [String(j._id), j]));

  return applied.map(entry => {
    const live = jobMap.get(entry.jobId);
    return {
      jobId: entry.jobId,
      jobTitle: live?.JobTitle || entry.jobTitle || 'Job no longer available',
      company: live?.Company || entry.company || 'Unknown company',
      applicationURL: live?.DirectApplyURL || live?.ApplicationURL || entry.applicationURL || null,
      location: live?.Location || entry.location || null,
      department: live?.Department || entry.department || null,
      stage: entry.stage || 'applied',
      stageUpdatedAt: entry.stageUpdatedAt || entry.appliedAt,
      appliedAt: entry.appliedAt,
      isListingActive: !!live,
    };
  });
}

/**
 * Add a job to appliedJobs and bump appliedCount.
 * Idempotent: re-applying the same job is a no-op.
 */
export async function addAppliedJob(userId, jobId, snapshot = {}) {
  const oid = toOid(userId);
  if (!oid || !jobId) return [];
  const col = await usersCol();

  // Wipe any legacy string entry for the same jobId so we don't double-store.
  await col.updateOne({ _id: oid }, { $pull: { appliedJobs: jobId } });

  const entry = {
    jobId,
    appliedAt: new Date(),
    jobTitle: snapshot.jobTitle || null,
    company: snapshot.company || null,
    applicationURL: snapshot.applicationURL || null,
    location: snapshot.location || null,
    department: snapshot.department || null,
    stage: 'applied',
    stageUpdatedAt: new Date(),
  };

  // Only push + increment if this jobId isn't already there.
  const result = await col.findOneAndUpdate(
    { _id: oid, 'appliedJobs.jobId': { $ne: jobId } },
    { $push: { appliedJobs: entry }, $inc: { appliedCount: 1 } },
    { returnDocument: 'after' },
  );
  if (result) return normaliseApplied(result.appliedJobs);

  // Already applied: just return current list.
  const existing = await col.findOne({ _id: oid }, { projection: { appliedJobs: 1, _id: 0 } });
  return existing ? normaliseApplied(existing.appliedJobs) : [];
}

/**
 * Remove a job from appliedJobs.
 * FIX: decrement appliedCount when something was actually removed.
 * Also clamps to >= 0 so legacy bad data can't go negative.
 */
export async function removeAppliedJob(userId, jobId) {
  const oid = toOid(userId);
  if (!oid || !jobId) return [];
  const col = await usersCol();

  // Step 1: did this user actually have this jobId? Check both formats.
  const found = await col.findOne(
    { _id: oid, $or: [{ 'appliedJobs.jobId': jobId }, { appliedJobs: jobId }] },
    { projection: { _id: 1 } },
  );

  // Pull both legacy string form and current object form.
  await col.updateOne(
    { _id: oid },
    { $pull: { appliedJobs: jobId } },
  );
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $pull: { appliedJobs: { jobId } } },
    { returnDocument: 'after' },
  );

  // Step 2: decrement counter only if we actually removed something.
  if (found && result) {
    await col.updateOne(
      { _id: oid, appliedCount: { $gt: 0 } },
      { $inc: { appliedCount: -1 } },
    );
  }
  return result ? normaliseApplied(result.appliedJobs) : [];
}

/** Update the pipeline stage for an applied job. */
export async function updateAppliedJobStage(userId, jobId, stage) {
  const oid = toOid(userId);
  if (!oid) return null;
  if (!VALID_STAGES.includes(stage)) return null;
  const col = await usersCol();
  const result = await col.findOneAndUpdate(
    { _id: oid, 'appliedJobs.jobId': jobId },
    { $set: {
      'appliedJobs.$.stage': stage,
      'appliedJobs.$.stageUpdatedAt': new Date(),
    }},
    { returnDocument: 'after' },
  );
  return result ? normaliseApplied(result.appliedJobs) : null;
}
