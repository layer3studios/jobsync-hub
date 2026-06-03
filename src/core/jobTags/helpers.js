// FILE: src/core/jobTags/helpers.js
// Shared helpers used across all jobTags submodules.

import he from 'he';

export function stripHtmlAndDecode(html = '') {
  return he.decode(String(html))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain-text form of the description, with fallbacks. */
export function getPlainDescription(job = {}) {
  return stripHtmlAndDecode(job.DescriptionPlain || job.DescriptionCleaned || job.Description || '');
}

/** Count regex matches in a string. Resets lastIndex so global regexes are safe to reuse. */
export function countMatches(regex, text) {
  let count = 0;
  regex.lastIndex = 0;
  while (regex.exec(text)) count++;
  regex.lastIndex = 0;
  return count;
}

/** Build a token-boundary regex for an array of patterns. Case-insensitive. */
export function buildTokenRegex(patterns) {
  const joined = patterns.join('|');
  return new RegExp(`(^|[^a-z0-9+#])(?:${joined})(?=$|[^a-z0-9+#])`, 'gi');
}

export const EMPTY_AUTO_TAGS = Object.freeze({
  techStack: [],
  roleCategory: 'Other',
  experienceBand: null,
  isEntryLevel: false,
  domain: [],
  urgency: null,
  education: null,
});
