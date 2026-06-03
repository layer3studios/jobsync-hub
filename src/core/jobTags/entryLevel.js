// FILE: src/core/jobTags/entryLevel.js
// Decides whether a job is "entry-level / fresher-friendly".

import { getPlainDescription } from './helpers.js';
import { extractExperienceMentions } from './experience.js';

const STRONG_ENTRY_REGEXES = [
  /\bfreshers?\b/i,
  /\b0\s*(?:-|–|to)\s*[12]\s*(?:years?|yrs?)\b/i,
  /\bentry[\s-]?level\b/i,
  /\bnew\s+grad(?:uate)?\b/i,
  /\brecent\s+grad(?:uate)?\b/i,
  /\bcampus\s+(?:hire|hiring|recruitment|placement)\b/i,
  /\bgraduate\s+engineer\s+trainee\b/i,
  /\bGET\b/i,
  /\bno\s+(?:prior\s+)?experience\s+required\b/i,
  /\bstarting\s+your\s+career\b/i,
  /\bstart\s+your\s+career\b/i,
  /\bbegin\s+your\s+career\b/i,
  /\blaunch\s+your\s+career\b/i,
  /\b202[4-6]\s+batch\b/i,
  /\bfreshers?\s+(?:welcome|encouraged|can\s+apply)\b/i,
  /\bintern(?:ship)?\s+to\s+full(?:\s*time)?\b/i,
  /\bintern\s+to\s+full\b/i,
];

const MODERATE_ENTRY_CHECKS = [
  ({ title }) => /\bjunior\b/i.test(title),
  ({ title }) => /\banalyst\b/i.test(title) && !/\b(?:senior|lead|principal)\b/i.test(title),
  ({ title }) => /\bassociate\s+(?:engineer|developer)\b/i.test(title) && !/\bsenior\b/i.test(title),
  ({ text }) => /\b1\s*(?:-|–|to)\s*[23]\s*(?:years?|yrs?)\b/i.test(text),
  ({ text }) => /\bearly\s+(?:career|in\s+career)\b/i.test(text),
  ({ text }) => /\blearning\s+opportunity\b/i.test(text) || /\bmentorship\b/i.test(text)
    || /\bwe(?:\s+will|'ll)\s+teach\s+you\b/i.test(text) || /\btraining\s+provided\b/i.test(text),
  ({ text }) => /\b(?:B\.?Tech|B\.?E|BE)\b/i.test(text),
  ({ text }) => /\b(?:CGPA|percentage)\b/i.test(text),
];

const STRONG_NEGATIVE_TITLE =
  /\b(?:senior|sr\.?|staff|principal|lead|director|head\s+of|vp|vice\s+president|manager|architect)\b/i;
const STRONG_NEGATIVE_TEXT = /\b(?:extensive\s+experience|proven\s+track\s+record|deep\s+expertise)\b/i;

export function inferEntryLevel(job, experienceBand) {
  const title = String(job.JobTitle ?? '');
  const desc = getPlainDescription(job);
  const text = `${title} ${desc}`;

  // Hard reject if the description explicitly demands experience.
  const yearsBlock = extractExperienceMentions(desc).some(m => m.min >= 2 || m.max >= 2);
  if (STRONG_NEGATIVE_TITLE.test(title) || yearsBlock || STRONG_NEGATIVE_TEXT.test(text)) {
    return false;
  }

  // Strong positive title hint
  if (/\b(?:associate\s+engineer|associate\s+developer|trainee)\b/i.test(title) && !/\bsenior\b/i.test(title)) {
    return true;
  }

  if (experienceBand === 'Fresher (0-1y)') return true;
  if (STRONG_ENTRY_REGEXES.some(re => re.test(text))) return true;

  // 2+ moderate hits qualify
  let hits = 0;
  for (const check of MODERATE_ENTRY_CHECKS) {
    if (check({ title, text })) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}
