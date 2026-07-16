// FILE: src/services/public/scoring-prompt.js
// Builds the single Gemma scoring prompt (D3, R1) — full resume text + the job's
// structured parsedRequirements, one call, no embeddings (C9). The rubric is
// strict and Indian-market-aware (R2) and tells Gemma to recognize skill
// equivalences (R3). parseScoreResponse maps the snake_case JSON Gemma returns
// into the camelCase shape the model stores; normalization happens in the model.

const MAXIMUM_RESUME_CHARACTERS = 10000;

const RUBRIC = `Score 0-100 using this rubric:
85-100 = Strong: core skills align, experience fits, location OK
65-84  = Good: most skills match, minor gaps
50-64  = Partial: some overlap, significant gaps
30-49  = Weak: few matches, wrong level
0-29   = Poor: different domain
Overqualification is negative (a 15-year VP applying to a junior role scores 30-40, not 90).

Recognize skill equivalences: React=React.js=ReactJS, AWS=Amazon Web Services, Frontend≈React+CSS+JS.`;

const RESPONSE_SHAPE = `Return ONLY valid JSON:
{
  "score": <int 0-100>,
  "matched_skills": ["skills from resume matching requirements"],
  "missing_skills": ["required skills NOT in resume"],
  "bonus_skills": ["resume skills not required but valuable"],
  "experience_fit": "<strong|good|weak|overqualified>",
  "location_fit": "<exact|same_state|remote_compatible|relocation>",
  "notice_period_fit": "<immediate|within_30|within_60|long_notice|unknown>",
  "explanation": "<2-3 sentences, max 500 chars, specific>",
  "contact_fields": {
    "linkedin_url": <string|null>,
    "github_url": <string|null>,
    "portfolio_url": <string|null>,
    "location": <string|null>
  }
}`;

const CONTACT_INSTRUCTION = 'Extract contact_fields ONLY from what appears in the resume text. Do not infer. Return null for anything not found. Return the URLs exactly as they appear.';

/** Assemble the system instruction for one candidate scoring call. */
export function buildScoringSystemPrompt(parsedRequirements, resumeText) {
  const requirementsJson = JSON.stringify(parsedRequirements, null, 2);
  const truncatedResume = String(resumeText || '').slice(0, MAXIMUM_RESUME_CHARACTERS);
  return `You are an experienced Indian technical recruiter scoring a candidate's resume against a job description. Be strict but fair.

JOB REQUIREMENTS (structured):
${requirementsJson}

CANDIDATE RESUME TEXT:
${truncatedResume}

${RUBRIC}

${CONTACT_INSTRUCTION}

${RESPONSE_SHAPE}`;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Gemma returned unparseable scoring JSON');
  }
}

const MAXIMUM_LOCATION_CHARACTERS = 200;

/**
 * An LLM-supplied absolute http(s) URL, optionally host-constrained. Anything that
 * fails — wrong scheme, unparseable, wrong host — becomes null SILENTLY: Gemma
 * hallucinates occasionally, and one bad URL must never break scoring.
 */
export function validateExtractedUrl(raw, mustIncludeHost = null) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (mustIncludeHost && !parsed.hostname.toLowerCase().includes(mustIncludeHost)) return null;
  return trimmed;
}

/** Trimmed location capped at 200 chars; empty/whitespace-only → null. */
export function validateExtractedLocation(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAXIMUM_LOCATION_CHARACTERS) : null;
}

/** Map + validate Gemma's contact_fields block. Absent or malformed → null. */
function parseContactFields(rawContactFields) {
  const isPlainObject = rawContactFields != null
    && typeof rawContactFields === 'object'
    && !Array.isArray(rawContactFields);
  if (!isPlainObject) return null;
  return {
    linkedinUrl: validateExtractedUrl(rawContactFields.linkedin_url, 'linkedin.com'),
    githubUrl: validateExtractedUrl(rawContactFields.github_url, 'github.com'),
    portfolioUrl: validateExtractedUrl(rawContactFields.portfolio_url),
    location: validateExtractedLocation(rawContactFields.location),
  };
}

/**
 * Map Gemma's snake_case response into the camelCase score data shape.
 * `contactFields` rides alongside — the caller peels it off so it never reaches
 * upsertResumeScore.
 */
export function parseScoreResponse(raw) {
  const parsed = parseJson(raw);
  return {
    contactFields: parseContactFields(parsed.contact_fields),
    score: parsed.score,
    matchedSkills: parsed.matched_skills,
    missingSkills: parsed.missing_skills,
    bonusSkills: parsed.bonus_skills,
    experienceFit: parsed.experience_fit,
    locationFit: parsed.location_fit,
    noticePeriodFit: parsed.notice_period_fit,
    explanation: parsed.explanation,
  };
}
