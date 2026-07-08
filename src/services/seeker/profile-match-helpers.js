// FILE: src/services/seeker/profile-match-helpers.js
// Pure, DB-free matching primitives shared by the market services (F3b).
// Jaccard-lite skill matching over a small canonical alias table (D1/D8, R2).
// Bi-schema aware: scraped jobs use PascalCase, native jobs camelCase (R5) —
// every field is resolved once per doc through a shared helper so a schema
// change on one side can't silently break the other.

// Recency window for an "active" posting to count as current (D2). Code
// constant, never an env var (C7/V7).
export const RECENT_POSTING_DAYS = 60;
// Role-category bucket for native postings (no autoTags) in breakdowns (D3).
export const UNCATEGORIZED = 'Uncategorized';
const STATUS_ACTIVE = 'active';
const DAY_MILLISECONDS = 86_400_000;

// Canonical → aliases (D8). Deliberately small; expanding it is an intentional
// PR decision, not a prompt-time one — add a justifying comment per entry.
export const SKILL_ALIASES = {
  react: ['reactjs', 'react.js'],
  node: ['nodejs', 'node.js'],
  aws: ['amazon web services'],
  gcp: ['google cloud'],
  k8s: ['kubernetes'],
  js: ['javascript'],
  ts: ['typescript'],
  py: ['python'],
  postgres: ['postgresql'],
  mongo: ['mongodb'],
  ml: ['machine learning'],
  ai: ['artificial intelligence'],
  nlp: ['natural language processing'],
  css: ['css3'],
  html: ['html5'],
};

// lowercase, trim, collapse whitespace, strip punctuation except + and #
// (keeps C++, C#). Dots are dropped so "react.js" folds onto "reactjs" (D1).
function baseNormalize(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIAS_TO_CANONICAL = (() => {
  const map = new Map();
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    map.set(baseNormalize(canonical), canonical);
    for (const alias of aliases) map.set(baseNormalize(alias), canonical);
  }
  return map;
})();

/** Normalize one skill string to its canonical form. Returns '' for empties. */
export function normalizeSkill(raw) {
  const base = baseNormalize(raw);
  if (!base) return '';
  return ALIAS_TO_CANONICAL.get(base) || base;
}

/** Build a Set of canonical skills from an array of strings. */
export function normalizeSkillSet(list) {
  const set = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const canonical = normalizeSkill(item);
    if (canonical) set.add(canonical);
  }
  return set;
}

// Seeker skills are objects { name, category, proficiency } (resume-parser).
function seekerSkillNames(profile) {
  return (Array.isArray(profile?.skills) ? profile.skills : []).map((s) => s?.name);
}

/** Resolve a posting's active flag across both schemas. */
export function isJobActive(job) {
  return job?.Status === STATUS_ACTIVE || job?.status === STATUS_ACTIVE;
}

/** Resolve the posting date across both schemas (native → scraped → fallback). */
export function resolvePostedDate(job) {
  const raw = job?.postedAt ?? job?.PostedDate ?? job?.createdAt ?? null;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Resolve the posting location across both schemas. */
export function resolveJobLocation(job) {
  return job?.location || job?.Location || null;
}

/** Role category for breakdowns: scraped autoTags, else Uncategorized (D3). */
export function resolveRoleCategory(job) {
  const category = job?.autoTags?.roleCategory;
  return typeof category === 'string' && category ? category : UNCATEGORIZED;
}

function intersectionSize(a, b) {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function experiencePasses(profile, req) {
  const years = profile?.totalExperienceYears;
  // No seeker experience signal → don't exclude on experience.
  if (typeof years !== 'number' || Number.isNaN(years)) return true;
  const min = typeof req.min_experience_years === 'number' ? req.min_experience_years - 1 : null;
  const max = typeof req.max_experience_years === 'number' ? req.max_experience_years + 2 : null;
  if (min !== null && years < min) return false;
  if (max !== null && years > max) return false;
  return true;
}

/**
 * Pure match predicate (D2). True when the posting is active, recent, and the
 * seeker clears both the skill threshold and the experience band. `now` is
 * injectable so tests can pin the recency cutoff.
 */
export function matchesJobForProfile(job, profile, now = Date.now()) {
  const req = job?.parsedRequirements;
  if (!req) return false;
  if (!isJobActive(job)) return false;

  const posted = resolvePostedDate(job);
  if (!posted) return false;
  if (now - posted.getTime() > RECENT_POSTING_DAYS * DAY_MILLISECONDS) return false;

  const required = Array.isArray(req.required_skills) ? req.required_skills : [];
  const reqSet = normalizeSkillSet([...required, ...(req.preferred_skills || [])]);
  const seekSet = normalizeSkillSet(seekerSkillNames(profile));
  const matchedCount = intersectionSize(reqSet, seekSet);
  const threshold = Math.min(3, required.length);
  if (matchedCount < threshold) return false;

  return experiencePasses(profile, req);
}

/**
 * Shared $match for the `jobs` aggregation guard (R5). parsedRequirements +
 * active + recent, expressed with $and so the two $or clauses coexist (a plain
 * object cannot hold two `$or` keys). Reused by both market services.
 */
export function buildBaseJobMatch(now = Date.now()) {
  const cutoff = new Date(now - RECENT_POSTING_DAYS * DAY_MILLISECONDS);
  return {
    parsedRequirements: { $exists: true },
    $and: [
      { $or: [{ status: STATUS_ACTIVE }, { Status: STATUS_ACTIVE }] },
      { $or: [{ postedAt: { $gte: cutoff } }, { PostedDate: { $gte: cutoff } }, { createdAt: { $gte: cutoff } }] },
    ],
  };
}
