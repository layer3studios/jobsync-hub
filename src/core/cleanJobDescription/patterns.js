// FILE: src/core/cleanJobDescription/patterns.js
// Pattern catalogues used by the description classifier.

export const ROLE_CONTENT_PATTERNS = [
  /about\s+the\s+(role|position|job)/i,
  /^the\s+role$/i,
  /role\s+overview/i,
  /position\s+overview/i,
  /what\s+you['\u2019]?ll?\s+do/i,
  /what\s+will\s+you\s+do/i,
  /day[\s-]to[\s-]day/i,
  /\bresponsibilities\b/i,
  /key\s+responsibilities/i,
  /your\s+responsibilities/i,
  /what\s+we['\u2019]?re?\s+looking\s+for/i,
  /\brequirements\b/i,
  /\bqualifications\b/i,
  /what\s+you['\u2019]?ll?\s+need/i,
  /what\s+you\s+need/i,
  /who\s+you\s+are/i,
  /about\s+you/i,
  /must[\s-]have/i,
  /nice[\s-]to[\s-]have/i,
  /\bbonus\b/i,
  /preferred(\s+qualifications)?/i,
  /good\s+to\s+have/i,
  /tech\s+stack/i,
  /\btechnologies\b/i,
  /tools\s+(&|and)\s+tech/i,
  /skills\s+(&|and)\s+experience/i,
  /skills\s+(&|and)\s+requirements/i,
  /technical\s+skills/i,
];

export const COMPANY_INFO_PATTERNS = [
  /who\s+we\s+are/i,
  /^about\s+us$/i,
  /^about\s+\w/i,
  /the\s+community\s+you\s+will\s+join/i,
  /our\s+mission/i,
  /our\s+story/i,
  /our\s+values/i,
  /company\s+overview/i,
  /^the\s+company$/i,
  /our\s+team/i,
  /what\s+we\s+do/i,
  /our\s+product/i,
  /^overview$/i,
];

export const BOILERPLATE_PATTERNS = [
  /\bbenefits\b/i,
  /\bperks\b/i,
  /what\s+we\s+offer/i,
  /\bcompensation(\s+&\s+benefits)?/i,
  /why\s+join/i,
  /why\s+us/i,
  /equal\s+opportunity/i,
  /\beeo\b/i,
  /\bdiversity\b/i,
  /\binclusion\b/i,
  /\baccessibility\b/i,
  /how\s+to\s+apply/i,
  /application\s+process/i,
  /next\s+steps/i,
  /about\s+the\s+(offer|package)/i,
  /salary\s+&\s+benefits/i,
  /total\s+rewards/i,
  /what\s+you['\u2019]?ll?\s+get/i,
  /life\s+at\s+\w/i,
  /working\s+at\s+\w/i,
];

export const COMPANY_INTRO_CONTENT_PATTERNS = [
  /\bwas\s+born\s+in\b/i,
  /\bhas\s+since\s+grown\b/i,
  /\bwelcomed\s+over\b/i,
  /\bin\s+almost\s+every\s+country\b/i,
  /\bguests?\s+to\s+connect\s+with\s+communities\b/i,
  /\bevery\s+day,?\s+hosts?\s+offer\s+unique\s+stays?\b/i,
];

export const INTRO_CLASS_HINTS = ['content-intro', 'company-intro', 'about-company', 'about-us'];

export const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Classify a heading-text string into one of four categories. */
export function classify(text) {
  if (!text) return 'UNKNOWN';
  if (ROLE_CONTENT_PATTERNS.some(p => p.test(text))) return 'ROLE_CONTENT';
  if (COMPANY_INFO_PATTERNS.some(p => p.test(text))) return 'COMPANY_INFO';
  if (BOILERPLATE_PATTERNS.some(p => p.test(text))) return 'BOILERPLATE';
  return 'UNKNOWN';
}
