// FILE: src/models/user/comeback.js
// "Save for later" bookmarks with optional notes.

import { usersCol, toOid } from './_shared.js';

export async function getComeBackTo(userId) {
  const oid = toOid(userId);
  if (!oid) return [];
  const col = await usersCol();
  const user = await col.findOne({ _id: oid }, { projection: { comeBackTo: 1, _id: 0 } });
  return Array.isArray(user?.comeBackTo) ? user.comeBackTo : [];
}

/**
 * Insert or replace a comeback entry. Note capped at 200 chars.
 * Returns the updated comeBackTo array.
 */
export async function upsertComeBackTo(userId, jobId, note) {
  const oid = toOid(userId);
  if (!oid || !jobId) return [];
  const safeNote = typeof note === 'string' ? note.slice(0, 200) : '';
  const col = await usersCol();
  // Atomic-ish: pull old entry, then push new one.
  await col.updateOne({ _id: oid }, { $pull: { comeBackTo: { jobId } } });
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $push: { comeBackTo: { jobId, note: safeNote, addedAt: new Date() } } },
    { returnDocument: 'after' },
  );
  return Array.isArray(result?.comeBackTo) ? result.comeBackTo : [];
}

export async function removeComeBackTo(userId, jobId) {
  const oid = toOid(userId);
  if (!oid || !jobId) return [];
  const col = await usersCol();
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $pull: { comeBackTo: { jobId } } },
    { returnDocument: 'after' },
  );
  return Array.isArray(result?.comeBackTo) ? result.comeBackTo : [];
}
