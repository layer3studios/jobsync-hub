// FILE: src/core/jobTags/extras.js
// Domain, urgency, and education inference. Small, pattern-driven.

import { countMatches, getPlainDescription } from './helpers.js';

const DOMAIN_RULES = [
  { label: 'Fintech',          regex: /\b(?:fintech|banking|lending|insurance|financial\s+services|neobank|trading|investment)\b/gi },
  { label: 'Payments',         regex: /\b(?:payment|payments|wallet|UPI|BNPL)\b/gi },
  { label: 'Blockchain/Crypto',regex: /\b(?:blockchain|crypto|web3)\b/gi },
  { label: 'SaaS',             regex: /\b(?:saas|cloud\s+software|software\s+platform)\b/gi },
  { label: 'B2B',              regex: /\b(?:b2b|enterprise\s+software|enterprise\s+platform)\b/gi },
  { label: 'E-commerce',       regex: /\b(?:e-commerce|ecommerce|marketplace|retail|D2C|shopping)\b/gi },
  { label: 'Healthtech',       regex: /\b(?:healthtech|healthcare|medical|pharma|clinical|telemedicine|health)\b/gi },
  { label: 'Edtech',           regex: /\b(?:edtech|ed-tech|education|learning|e-learning)\b/gi },
  { label: 'Gaming',           regex: /\b(?:gaming|esports|game(?:s|ing)?)\b/gi },
  { label: 'Logistics',        regex: /\b(?:logistics|supply\s+chain|delivery|fleet|warehouse|shipping)\b/gi },
  { label: 'AI/ML',            regex: /\b(?:artificial\s+intelligence|machine\s+learning|AI-first|AI\s+company|GenAI|generative\s+AI)\b/gi },
];

const URGENCY_RULES = [
  { label: 'Immediate Joiner', regex: /\b(?:immediate\s+joiner|immediate\s+joining|early\s+joiner\s+preferred)\b/i },
  { label: 'Urgent',           regex: /\b(?:urgent|urgently\s+hiring|immediate\s+requirement)\b/i },
];

const EDUCATION_RULES = [
  { label: 'PhD',       regex: /\b(?:Ph\.?D|doctorate)\b/i, rank: 4 },
  { label: 'MBA',       regex: /\bMBA\b/i, rank: 3 },
  { label: 'MTech/MS',  regex: /\b(?:M\.?Tech|MS|Master(?:'s)?)\b/i, rank: 2 },
  { label: 'BTech/BE',  regex: /\b(?:B\.?Tech|B\.?E|BE|Bachelor(?:'s)?)\b/i, rank: 1 },
];

export function inferDomain(job) {
  const haystack = `${job.Company ?? ''} ${getPlainDescription(job)}`;
  return DOMAIN_RULES
    .map(r => ({ label: r.label, hits: countMatches(r.regex, haystack) }))
    .filter(d => d.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.label.localeCompare(b.label))
    .slice(0, 2)
    .map(d => d.label);
}

export function inferUrgency(job) {
  const text = getPlainDescription(job);
  for (const rule of URGENCY_RULES) if (rule.regex.test(text)) return rule.label;
  return null;
}

export function inferEducation(job) {
  const text = getPlainDescription(job);
  let selected = null;
  for (const rule of EDUCATION_RULES) {
    if (rule.regex.test(text) && (!selected || rule.rank > selected.rank)) selected = rule;
  }
  return selected?.label ?? null;
}
