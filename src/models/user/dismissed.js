// FILE: src/models/user/dismissed.js
// Per-user "not interested" list. Uses $addToSet so duplicates are impossible.

import { usersCol, toOid } from './_shared.js';

export async function getDismissedJobs(userId) {
  const oid = toOid(userId);
  if (!oid) return [];
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { dismissedJobs: 1 } });
  return Array.isArray(user?.dismissedJobs) ? user.dismissedJobs : [];
}

export async function addDismissedJob(userId, jobId) {
  const oid = toOid(userId);
  if (!oid || !jobId) return [];
  const col = await usersCol();
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $addToSet: { dismissedJobs: jobId } },
    { returnDocument: 'after' },
  );
  return Array.isArray(result?.dismissedJobs) ? result.dismissedJobs : [];
}

export async function removeDismissedJob(userId, jobId) {
  const oid = toOid(userId);
  if (!oid || !jobId) return [];
  const col = await usersCol();
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $pull: { dismissedJobs: jobId } },
    { returnDocument: 'after' },
  );
  return Array.isArray(result?.dismissedJobs) ? result.dismissedJobs : [];
}
