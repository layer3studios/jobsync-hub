// FILE: src/models/user/preferences.js
// Daily goal + last-visit tracking.

import { usersCol, toOid } from './_shared.js';

/**
 * Touch lastVisitAt. Returns { previousVisitAt, updatedVisitAt }.
 */
export async function touchVisit(userId) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const prev = await col.findOneAndUpdate(
    { _id: oid },
    { $set: { lastVisitAt: new Date() } },
    { returnDocument: 'before' },
  );
  if (!prev) return null;
  return {
    previousVisitAt: prev.lastVisitAt ?? null,
    updatedVisitAt: new Date(),
  };
}

/**
 * Set the user's daily-apply goal. Clamped to [1, 50]. Defaults to 5 on bad input.
 * Returns the new goal value, or null when user not found.
 */
export async function setDailyGoal(userId, goal) {
  const oid = toOid(userId);
  if (!oid) return null;
  const col = await usersCol();
  const validated = Math.max(1, Math.min(50, parseInt(goal, 10) || 5));
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $set: { dailyGoal: validated } },
    { returnDocument: 'after' },
  );
  return result ? (result.dailyGoal ?? 5) : null;
}
