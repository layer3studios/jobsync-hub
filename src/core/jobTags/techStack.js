// FILE: src/core/jobTags/techStack.js
// Tech stack inference. Token-boundary regex matching against canonical names.
// Definitions live in techStackDefinitions.js (pure data).

import { buildTokenRegex, countMatches, getPlainDescription } from './helpers.js';
import { TECH_STACK_DEFINITIONS } from './techStackDefinitions.js';

const MATCHERS = TECH_STACK_DEFINITIONS.map(def => ({
  ...def,
  regex: buildTokenRegex(def.patterns),
}));

// "Go" and "R" need extra-careful matching to avoid false positives.

function hasStandaloneGoTerm(text) {
  return /(^|[^a-z0-9])go(?=$|[\s,/.:-])/i.test(text);
}

function scoreGo(title, text) {
  const titleHint = /\b(?:go\s+developer|go\s+engineer|golang)\b/i.test(title);
  const textHint = /\b(?:golang|goroutine|gorilla|gin\s+framework|go\s+developer|go\s+engineer|func\s+[a-z_][a-z0-9_]*)\b/i.test(text);
  if (!titleHint && !(textHint && hasStandaloneGoTerm(text))) return null;
  return {
    canonical: 'Go',
    titleHits: titleHint ? 1 : 0,
    descHits: countMatches(/\b(?:golang|goroutine|gorilla|gin\s+framework)\b/gi, text)
      + (hasStandaloneGoTerm(text) ? 1 : 0),
  };
}

function scoreRLanguage(title, text) {
  const titleHint = /\br\s+developer\b/i.test(title);
  const textRegex = /\b(?:r\s+programming|r\s+language|rstudio|cran|tidyverse)\b/gi;
  const descHits = countMatches(textRegex, text);
  if (!titleHint && descHits === 0) return null;
  return { canonical: 'R', titleHits: titleHint ? 1 : 0, descHits };
}

export function inferTechStack(job) {
  const title = String(job.JobTitle ?? '');
  const text = getPlainDescription(job);
  const scored = [];

  for (const m of MATCHERS) {
    const titleHits = countMatches(m.regex, title);
    const descHits = countMatches(m.regex, text);
    if (titleHits === 0 && descHits === 0) continue;
    scored.push({ canonical: m.canonical, titleHits, descHits });
  }

  const go = scoreGo(title, text);
  if (go) scored.push(go);
  const r = scoreRLanguage(title, text);
  if (r) scored.push(r);

  const deduped = new Map();
  for (const s of scored) {
    const ex = deduped.get(s.canonical);
    if (ex) { ex.titleHits += s.titleHits; ex.descHits += s.descHits; }
    else deduped.set(s.canonical, { ...s });
  }

  return [...deduped.values()]
    .sort((a, b) => {
      if (b.titleHits !== a.titleHits) return b.titleHits - a.titleHits;
      if (b.descHits !== a.descHits) return b.descHits - a.descHits;
      return a.canonical.localeCompare(b.canonical);
    })
    .slice(0, 12)
    .map(s => s.canonical);
}
