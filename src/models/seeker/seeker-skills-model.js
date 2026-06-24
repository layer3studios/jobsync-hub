// FILE: src/models/user/skills.js
import { usersCol, toOid } from './_shared.js';

/**
 * Replace the user's skills array. Trims, dedupes, caps at 100.
 * Returns the new array, or [] when user not found.
 */
export async function updateSkills(userId, skills) {
  const oid = toOid(userId);
  if (!oid) return [];
  const sanitised = Array.isArray(skills)
    ? [...new Set(skills.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))].slice(0, 100)
    : [];
  const col = await usersCol();
  const result = await col.findOneAndUpdate(
    { _id: oid },
    { $set: { skills: sanitised } },
    { returnDocument: 'after' },
  );
  return result?.skills ?? [];
}
