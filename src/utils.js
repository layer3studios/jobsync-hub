// FILE: src/utils.js
// Shared utility helpers and keyword vocabularies.
// Pure data + small pure functions. No side effects.

import he from 'he';

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Strip HTML tags from a string and collapse whitespace. */
export function StripHtml(html) {
  if (!html) return '';
  return he.decode(String(html)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize HTML: remove dangerous tags (script, iframe, style, object, embed, noscript)
 * and inline event handlers (onclick, onload, etc.). Keeps safe formatting tags.
 */
export function SanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?\/?>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/\s*on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s*on\w+\s*=\s*'[^']*'/gi, '')
    .trim();
}

// ─── Keyword vocabularies (used by processor + filters) ──────────────────

// Roles to always reject — not relevant tech jobs.
export const BANNED_ROLES = [
  'working student', 'student assistant',
  'apprentice', 'apprenticeship',
  'store manager', 'shop manager',
  'sales assistant', 'cashier',
  'phd thesis', 'master thesis', 'bachelor thesis',
];

// Title keywords that strongly imply entry-level (used for tagging only).
export const ENTRY_LEVEL_KEYWORDS = [
  'sde-1', 'sde 1', 'sde-i', 'sde i',
  'junior', 'jr.', 'jr ',
  'associate',
  'entry level', 'entry-level',
  'intern',
  'fresher', 'freshers',
  'trainee', 'graduate',
  'engineer', 'developer', 'analyst',
  'generalist', 'administrator',
  'executive', 'technician', 'coordinator', 'representative',
  'planner', 'specialist', 'designer', 'tester',
  'biologist', 'officer', 'supervisor', 'therapist',
  'consultant', 'editor', 'writer', 'operator', 'counsellor',
];

// Title keywords that reject "entry-level" classification.
export const SENIOR_REJECT_KEYWORDS = [
  'senior', 'sr.', 'sr ',
  'staff', 'principal', 'distinguished',
  'lead', 'head of', 'head,',
  'director', 'vp ', 'vice president',
  'chief', 'cto', 'cfo', 'coo', 'ceo',
  'manager',
  'architect',
  'sde-2', 'sde 2', 'sde-ii', 'sde ii',
  'sde-3', 'sde 3', 'sde-iii', 'sde iii',
  'level 3', 'level 4', 'level 5',
  'l3', 'l4', 'l5', 'l6', 'l7',
  'iii', 'iv', ' ii ', 'level ii',
];

// Broad set of titles that map to tech roles. Used as the pre-filter at processor stage.
export const TECH_ROLE_KEYWORDS = [
  // Software Development
  'software', 'developer', 'development', 'sde', 'swe',
  'programmer', 'coder', 'coding',
  'fullstack', 'full stack', 'full-stack',
  'frontend', 'front end', 'front-end',
  'backend', 'back end', 'back-end',
  'mern', 'mean', 'node', 'react', 'angular', 'vue',
  'java', 'python', 'javascript', 'typescript', 'golang', 'go ',
  'ruby', 'php', 'c++', 'c#', '.net', 'rust', 'kotlin', 'swift',

  // Data & AI
  'data analyst', 'data engineer', 'data scientist', 'data science',
  'machine learning', 'ml engineer', 'ai engineer', 'deep learning',
  'nlp', 'computer vision',
  'business analyst', 'product analyst', 'analytics',

  // DevOps, Cloud, Infra
  'devops', 'dev ops', 'sre', 'site reliability',
  'cloud', 'aws', 'azure', 'gcp',
  'infrastructure', 'platform engineer',
  'kubernetes', 'docker', 'terraform',
  'system admin', 'sysadmin', 'systems engineer',
  'network engineer', 'network admin',

  // QA
  'qa', 'quality assurance', 'tester', 'testing',
  'sdet', 'test engineer', 'automation engineer',

  // Security
  'security engineer', 'cybersecurity', 'cyber security',
  'infosec', 'soc analyst', 'penetration',

  // Design (tech)
  'ui/ux', 'ui ux', 'ux designer', 'ui designer',
  'product designer', 'ux researcher',

  // IT / support
  'it support', 'it engineer', 'it admin',
  'technical support', 'tech support',
  'helpdesk', 'help desk',

  // Product / project (tech)
  'product manager', 'product owner', 'scrum master',
  'project engineer', 'technical project',

  // Database
  'database', 'dba', 'sql', 'mongodb', 'postgres',
  'etl', 'data warehouse',

  // Embedded / hardware
  'embedded', 'firmware', 'iot',
  'hardware engineer', 'vlsi', 'asic', 'fpga',
  'electronic engineer', 'electronics engineer',

  // Mobile
  'mobile developer', 'android', 'ios developer',
  'flutter', 'react native',

  // Other
  'api', 'microservice', 'blockchain', 'web developer', 'web3',
  'game developer', 'graphics engineer',
  'technical writer', 'tech writer',
  'erp', 'sap', 'salesforce', 'crm developer',
  'linux', 'unix',

  // Generic tech titles common in India
  'engineer', 'analyst',
  'trainee', 'intern', 'fresher',
  'associate', 'junior', 'jr',
  'graduate engineer', 'get ', 'graduate trainee',
];
