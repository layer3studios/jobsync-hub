// FILE: src/services/seeker/resume-parser-service.js
// Sends resume text to Gemma and returns a normalized parsedProfile (D3/D4).
// Indian-market-tuned: CTC in LPA, notice period, CGPA/percentage, college tier,
// regional languages; ignores photos/DOB/marital status/declaration (R4). All
// output is defaulted/validated in code so storage sees a stable shape (R5).

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getScoringGemmaClient as getGemmaClient } from '../../gemma/gemma-runtime.js';

const SENIORITY_LEVELS = ['Entry', 'Mid', 'Senior', 'Lead', 'Executive'];

const SYSTEM_PROMPT = `You are a resume parser for the Indian job market. Extract structured data from the resume text below. Return ONLY valid JSON matching this schema:
{"fullName":string,"email":string|null,"phone":string|null,"currentLocation":{"city":string|null,"state":string|null},"linkedinUrl":string|null,"summary":string|null,"experience":[{"company":string,"title":string,"startDate":string,"endDate":string,"isCurrent":boolean,"responsibilities":[string],"technologies":[string]}],"education":[{"institution":string,"degree":string,"field":string,"startDate":string,"endDate":string,"cgpa":number|null,"percentage":number|null,"collegeTier":"Tier-1"|"Tier-2"|"Tier-3"|null}],"skills":[{"name":string,"category":string,"proficiency":string}],"totalExperienceYears":number|null,"seniorityLevel":"Entry"|"Mid"|"Senior"|"Lead"|"Executive"|null,"domain":string|null,"subDomain":string|null,"currentCTC":{"amount":number|null,"currency":"INR"}|null,"expectedCTC":{"amount":number|null,"currency":"INR"}|null,"noticePeriod":string|null,"languages":[{"language":string,"proficiency":string}],"certifications":[{"name":string,"issuer":string}],"projects":[{"name":string,"description":string,"technologies":[string]}]}
Rules:
- Tier-1 colleges: IIT, IIM, NIT, IIIT, BITS, IISc, ISI.
- CTC in LPA (lakhs per annum). Convert monthly to annual.
- Notice period: 'Immediate', '15 days', '30 days', '60 days', '90 days', or the exact text if different.
- IGNORE: photos, DOB, marital status, father's name, nationality, declaration text. Do NOT include these.
- Skills: infer from experience bullets too, not just the skills section. Category: Language/Framework/Database/Cloud/Tool/Methodology/Domain.
- Dates: YYYY-MM format. 'Present' for current roles.
- If a field is not in the resume, return null or [].`;

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const strArr = (v) => arr(v).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());

function parseJson(raw) {
  try { return JSON.parse(raw); } catch {
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new HttpError(422, 'Could not parse the resume. Please try again.', 'RESUME_PARSE_FAILED');
  }
}

function ctc(value) {
  if (!value || typeof value !== 'object') return null;
  const amount = numOrNull(value.amount);
  return amount === null ? null : { amount, currency: 'INR' };
}

function normalize(p) {
  return {
    fullName: strOrNull(p.fullName),
    email: strOrNull(p.email),
    phone: strOrNull(p.phone),
    currentLocation: {
      city: strOrNull(p.currentLocation?.city),
      state: strOrNull(p.currentLocation?.state),
    },
    linkedinUrl: strOrNull(p.linkedinUrl),
    summary: strOrNull(p.summary),
    experience: arr(p.experience).map((e) => ({
      company: strOrNull(e.company), title: strOrNull(e.title),
      startDate: strOrNull(e.startDate), endDate: strOrNull(e.endDate),
      isCurrent: Boolean(e.isCurrent),
      responsibilities: strArr(e.responsibilities), technologies: strArr(e.technologies),
    })),
    education: arr(p.education).map((e) => ({
      institution: strOrNull(e.institution), degree: strOrNull(e.degree), field: strOrNull(e.field),
      startDate: strOrNull(e.startDate), endDate: strOrNull(e.endDate),
      cgpa: numOrNull(e.cgpa), percentage: numOrNull(e.percentage),
      collegeTier: ['Tier-1', 'Tier-2', 'Tier-3'].includes(e.collegeTier) ? e.collegeTier : null,
    })),
    skills: arr(p.skills).map((s) => ({
      name: strOrNull(s.name), category: strOrNull(s.category), proficiency: strOrNull(s.proficiency),
    })).filter((s) => s.name),
    totalExperienceYears: numOrNull(p.totalExperienceYears),
    seniorityLevel: SENIORITY_LEVELS.includes(p.seniorityLevel) ? p.seniorityLevel : null,
    domain: strOrNull(p.domain),
    subDomain: strOrNull(p.subDomain),
    currentCTC: ctc(p.currentCTC),
    expectedCTC: ctc(p.expectedCTC),
    noticePeriod: strOrNull(p.noticePeriod),
    languages: arr(p.languages).map((l) => ({
      language: strOrNull(l.language), proficiency: strOrNull(l.proficiency),
    })).filter((l) => l.language),
    certifications: arr(p.certifications).map((c) => ({
      name: strOrNull(c.name), issuer: strOrNull(c.issuer),
    })).filter((c) => c.name),
    projects: arr(p.projects).map((pr) => ({
      name: strOrNull(pr.name), description: strOrNull(pr.description), technologies: strArr(pr.technologies),
    })).filter((pr) => pr.name),
    parsedAt: new Date().toISOString(),
  };
}

/** Parse resume text into a normalized profile. Throws 503 if Gemma is off. */
export async function parseResumeText(text) {
  const client = getGemmaClient();
  if (!client) throw new HttpError(503, 'Resume parsing is temporarily unavailable.', 'GEMMA_UNAVAILABLE');
  const raw = await client.generateContent(SYSTEM_PROMPT, String(text).slice(0, 100000));
  return normalize(parseJson(raw));
}

export default parseResumeText;
