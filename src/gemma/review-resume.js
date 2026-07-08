// FILE: src/gemma/review-resume.js
// Gemma-powered review of an already-parsed seeker profile — sibling to
// extract-requirements.js (same schema-in-prompt + regex-fallback JSON pattern,
// R2). Produces 4 dimension scores, section findings with verbatim evidence,
// strengths, and up to 3 improvement "asks" phrased as QUESTIONS the user must
// answer — never ghostwritten bullets (C10/R4). The overall score is recomputed
// in code (D6); Gemma's own overall is ignored. All output is clamped/normalized
// so storage sees a stable shape regardless of what the model emits.

import { GEMMA_MODEL } from '../env.js';

export const SECTIONS = {
  CONTACT: 'CONTACT', SUMMARY: 'SUMMARY', EXPERIENCE: 'EXPERIENCE',
  EDUCATION: 'EDUCATION', SKILLS: 'SKILLS', PROJECTS: 'PROJECTS',
  CERTIFICATIONS: 'CERTIFICATIONS', LAYOUT: 'LAYOUT',
};
export const SEVERITIES = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' };

// Employer-signal-weighted (D6). Keys map to scores.* fields.
const SCORE_WEIGHTS = { contentStrength: 0.35, skillsDepth: 0.25, indiaMarketFit: 0.20, parseability: 0.20 };

const SCHEMA = '{"scores":{"parseability":0,"contentStrength":0,"indiaMarketFit":0,"skillsDepth":0},'
  + '"strengths":[],"findings":[{"section":"EXPERIENCE","severity":"warning","message":"",'
  + '"sourceEvidence":null}],"topImprovements":[{"title":"","why":"","observedBullet":null,"question":""}]}';

const SYSTEM_PROMPT = `You are a senior Indian-market technical recruiter reviewing a parsed resume.
Return ONLY valid JSON matching this schema exactly: ${SCHEMA}.
Score each dimension 0-100 in 20-point bands:
- parseability: dates in YYYY-MM or MM/YYYY, contact block present and parseable, NO photo/DOB/marital-status/father's-name/declaration cruft, no multi-column artefacts.
- contentStrength: bullets start with an action verb, quantified with numbers/percentages/scope; penalize "responsible for", "worked on", "helped with"; each role has 3-6 impact bullets.
- indiaMarketFit: CTC in LPA if disclosed, notice period for experienced candidates, CGPA/percentage on freshers (<3 yrs), LinkedIn/GitHub links, professional email, NO personal fields.
- skillsDepth: skills grouped and matched to role/domain, not soft-skill padded, skills evidenced inside experience/projects.
section enum: CONTACT, SUMMARY, EXPERIENCE, EDUCATION, SKILLS, PROJECTS, CERTIFICATIONS, LAYOUT.
severity enum: critical, warning, info.
findings.sourceEvidence MUST be a verbatim substring of the input JSON, or null when the finding is about an absence.
strengths: max 3, each <=120 chars.
topImprovements: max 3, highest-impact first. Each is a QUESTION the user must answer to fill a gap.
Example - Observed: "Improved system performance." Ask: "By what percentage did performance improve, against what baseline (latency, throughput, cost), and over what timeframe?"
Do NOT rewrite bullets. Do NOT produce example or rewritten text. Do NOT quote back photo/DOB/marital status/father's name/religion/declaration - treat those as a parseability finding instead.
Do not invent data. Only observations, evidence, and questions.`;

function parseJson(raw) {
  try { return JSON.parse(raw); } catch {
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Gemma returned unparseable review JSON');
  }
}

const clampScore = (v) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(100, Math.max(0, n));
};
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const capStr = (v, max) => (strOrNull(v) ? v.trim().slice(0, max) : '');

function normalizeScores(raw) {
  const scores = {
    parseability: clampScore(raw?.parseability),
    contentStrength: clampScore(raw?.contentStrength),
    indiaMarketFit: clampScore(raw?.indiaMarketFit),
    skillsDepth: clampScore(raw?.skillsDepth),
  };
  const overall = Object.entries(SCORE_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + scores[key] * weight, 0);
  return { ...scores, overall: Math.round(overall) };
}

function normalizeFindings(raw) {
  const validSections = new Set(Object.values(SECTIONS));
  const validSeverities = new Set(Object.values(SEVERITIES));
  return (Array.isArray(raw) ? raw : [])
    .filter((f) => f && validSections.has(f.section) && validSeverities.has(f.severity))
    .map((f) => ({
      section: f.section,
      severity: f.severity,
      message: capStr(f.message, 200),
      sourceEvidence: strOrNull(f.sourceEvidence),
    }))
    .filter((f) => f.message);
}

function normalizeImprovements(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((i) => ({
      title: capStr(i?.title, 80),
      why: capStr(i?.why, 160),
      observedBullet: strOrNull(i?.observedBullet),
      question: capStr(i?.question, 180),
    }))
    .filter((i) => i.title && i.question)
    .slice(0, 3);
}

function normalize(parsed) {
  return {
    scores: normalizeScores(parsed.scores),
    strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, 120))
      .slice(0, 3),
    findings: normalizeFindings(parsed.findings),
    topImprovements: normalizeImprovements(parsed.topImprovements),
    reviewedAt: new Date().toISOString(),
    modelVersion: GEMMA_MODEL,
  };
}

/** Review a normalized parsedProfile. `client` is a GemmaClient. */
export async function reviewParsedProfile(parsedProfile, client) {
  if (!client) throw new Error('reviewParsedProfile: no Gemma client provided');
  const userMessage = JSON.stringify(parsedProfile ?? {}).slice(0, 12000);
  const raw = await client.generateContent(SYSTEM_PROMPT, userMessage);
  return normalize(parseJson(raw));
}

export default reviewParsedProfile;
