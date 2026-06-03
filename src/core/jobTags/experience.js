// FILE: src/core/jobTags/experience.js
// Years-of-experience extraction + band classification.

import { getPlainDescription } from './helpers.js';

const LEADERSHIP_CONTEXT =
  /(leadership|manager(?:ial|ment)?|people management|managed teams?|team lead|mentoring|mentor(?:ing)?|stakeholder management|cross-functional leadership)/i;

const RANGE_REGEX = /\b(\d{1,2})\s*(?:\+)?\s*(?:-|–|to)\s*(\d{1,2})\s*(?:years?|yrs?)\b/gi;
const SINGLE_REGEX = /\b(?:minimum\s+|minimum\s+of\s+|at\s+least\s+|around\s+)?(\d{1,2})\s*(\+)?\s*(?:years?|yrs?)\b(?:\s+of\s+experience)?/gi;

export function extractExperienceMentions(text) {
  const out = [];
  for (const match of text.matchAll(RANGE_REGEX)) {
    const min = Number(match[1]);
    const max = Number(match[2]);
    const index = match.index ?? 0;
    const ctx = text.slice(Math.max(0, index - 40), Math.min(text.length, index + match[0].length + 40));
    if (LEADERSHIP_CONTEXT.test(ctx)) continue;
    out.push({ min, max, raw: match[0], index, hasPlus: false, kind: 'range' });
  }
  for (const match of text.matchAll(SINGLE_REGEX)) {
    const min = Number(match[1]);
    const hasPlus = match[2] === '+';
    const index = match.index ?? 0;
    const ctx = text.slice(Math.max(0, index - 40), Math.min(text.length, index + match[0].length + 40));
    if (LEADERSHIP_CONTEXT.test(ctx)) continue;
    out.push({ min, max: min, raw: match[0], index, hasPlus, kind: 'single' });
  }
  return out;
}

function bandFromMention(m) {
  if (!m) return null;
  if (m.kind === 'range') {
    const { min, max } = m;
    if (min === 0 && max <= 1) return 'Fresher (0-1y)';
    if (min <= 1 && max <= 3) return 'Junior (1-3y)';
    if (min >= 8) return 'Staff+ (8y+)';
    if (min >= 5) return 'Senior (5-8y)';
    if (min >= 3) return 'Mid (3-5y)';
    if (max <= 1) return 'Fresher (0-1y)';
    if (max <= 3) return 'Junior (1-3y)';
    if (max <= 5) return 'Mid (3-5y)';
    if (max <= 8) return 'Senior (5-8y)';
    return 'Staff+ (8y+)';
  }
  const { min, hasPlus } = m;
  if (hasPlus) {
    if (min >= 8) return 'Staff+ (8y+)';
    if (min >= 5) return 'Senior (5-8y)';
    if (min >= 3) return 'Mid (3-5y)';
    if (min >= 1) return 'Junior (1-3y)';
    return 'Fresher (0-1y)';
  }
  if (min <= 1) return 'Fresher (0-1y)';
  if (min <= 3) return 'Junior (1-3y)';
  if (min <= 5) return 'Mid (3-5y)';
  if (min <= 8) return 'Senior (5-8y)';
  return 'Staff+ (8y+)';
}

export function inferExperienceBand(job) {
  const title = String(job.JobTitle ?? '');
  const text = getPlainDescription(job);
  const mentions = extractExperienceMentions(text).sort((a, b) => {
    if (b.min !== a.min) return b.min - a.min;
    if ((b.hasPlus ? 1 : 0) !== (a.hasPlus ? 1 : 0)) return (b.hasPlus ? 1 : 0) - (a.hasPlus ? 1 : 0);
    if (b.max !== a.max) return b.max - a.max;
    return a.index - b.index;
  });

  if (mentions.length > 0) return bandFromMention(mentions[0]);

  // Title-only fallback
  if (/\b(?:principal|staff)\b/i.test(title)) return 'Staff+ (8y+)';
  if (/\bsenior\b/i.test(title)) return 'Senior (5-8y)';
  if (/\b(?:mid|intermediate)\b/i.test(title)) return 'Mid (3-5y)';
  if (/\b(?:junior|associate)\b/i.test(title)) return 'Junior (1-3y)';
  if (/\b(?:intern|trainee|fresher|new\s+grad|graduate\s+engineer\s+trainee)\b/i.test(title)) return 'Fresher (0-1y)';
  return null;
}
