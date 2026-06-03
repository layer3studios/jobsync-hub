// FILE: src/core/processor/filters.js
// Per-job filter helpers used by the processor.

import { BANNED_ROLES, TECH_ROLE_KEYWORDS } from '../../utils.js';

const FUTURE_TOLERANCE_MS = 30 * 86400000;
const EPOCH_FLOOR = new Date('2000-01-01').getTime();

/**
 * Parse a PostedDate from any ATS shape (ISO string, ms timestamp, sec timestamp).
 * Rejects only impossible values: NaN, pre-2000, or >30 days in the future.
 * Old dates (even years old) are preserved — a stale listing is still real data.
 * Returns a Date or null.
 */
export function validatePostedDate(raw, label) {
  if (raw === null || raw === undefined || raw === '') return null;

  let d;
  const asNum = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^\d{10,13}$/.test(raw.trim()) ? Number(raw) : NaN);
  if (!Number.isNaN(asNum)) {
    // 13-digit = ms, 10-digit = seconds
    d = new Date(asNum > 1e11 ? asNum : asNum * 1000);
  } else {
    d = new Date(raw);
  }
  if (Number.isNaN(d.getTime())) return null;

  const ts = d.getTime();
  if (ts < EPOCH_FLOOR) {
    console.warn(`[processor] PostedDate before 2000${label ? ` (${label})` : ''}: ${raw}`);
    return null;
  }
  if (ts > Date.now() + FUTURE_TOLERANCE_MS) {
    console.warn(`[processor] PostedDate too far in future${label ? ` (${label})` : ''}: ${raw}`);
    return null;
  }
  return d;
}

/** Reject obvious non-tech / spam role titles. */
export function isSpamOrIrrelevant(title) {
  const lower = String(title || '').toLowerCase();
  return BANNED_ROLES.some(role => lower.includes(role));
}

/** Coarse tech-role gate. Used to drop non-tech listings before description fetch. */
export function isTechRole(title) {
  const lower = String(title || '').toLowerCase();
  return TECH_ROLE_KEYWORDS.some(kw => lower.includes(kw));
}

/** Title-based experience-level inference. Tagging only; no rejection. */
export function inferExperienceLevel(title) {
  const t = String(title || '').toLowerCase();
  if (/intern\b/.test(t)) return 'Intern';
  if (['sde-1', 'sde 1', 'sde-i', 'sde i', 'junior', 'jr.', 'jr ', 'fresher', 'trainee', 'graduate', 'entry level', 'entry-level'].some(k => t.includes(k))) return 'Entry Level';
  if (['senior', 'sr.', 'sr ', 'staff', 'principal'].some(k => t.includes(k))) return 'Senior';
  if (['lead', 'head', 'director', 'vp ', 'chief'].some(k => t.includes(k))) return 'Leadership';
  if (t.includes('manager')) return 'Manager';
  return 'Mid Level';
}
