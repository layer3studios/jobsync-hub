// FILE: src/core/processor/mappers/recruitee.js
import { validatePostedDate } from '../filters.js';

const EMPLOYMENT_MAP = {
  fulltime: 'Full-time',
  parttime: 'Part-time',
  internship: 'Internship',
  freelance: 'Freelance',
  contract: 'Contract',
  temporary: 'Temporary',
};

function normalizeWorkplace(raw) {
  if (raw.hybrid === true) return { workplaceType: 'hybrid', isRemote: false };
  if (raw.remote === true && raw.on_site === true) return { workplaceType: 'hybrid', isRemote: false };
  if (raw.remote === true) return { workplaceType: 'remote', isRemote: true };
  if (raw.on_site === true) return { workplaceType: 'on-site', isRemote: false };
  return { workplaceType: null, isRemote: null };
}

export function mapRecruiteeJob(raw, companyName, sourceSite) {
  let postedDate = raw.published_at ? validatePostedDate(raw.published_at, `Recruitee/${raw.id}`) : null;
  if (!postedDate && raw.created_at) {
    postedDate = validatePostedDate(raw.created_at, `Recruitee/${raw.id}/created_at`);
  }

  const allLocs = Array.isArray(raw.locations)
    ? raw.locations
        .map(loc => [loc.city, loc.state, loc.country].filter(Boolean).join(', '))
        .filter(Boolean)
    : [];

  let primaryLoc = null;
  if (Array.isArray(raw.locations) && raw.locations.length > 0) {
    const indiaLoc = raw.locations.find(loc =>
      loc?.country_code === 'IN'
      || (loc?.country && String(loc.country).toLowerCase() === 'india'),
    );
    const chosen = indiaLoc || raw.locations[0];
    primaryLoc = [chosen?.city, chosen?.state, chosen?.country].filter(Boolean).join(', ') || null;
  }

  const descParts = [raw.description, raw.requirements].filter(Boolean);
  const descHtml = descParts.join('\n\n') || null;
  const descPlain = descHtml
    ? descHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : null;

  const wp = normalizeWorkplace(raw);

  return {
    JobID: raw.id ? String(raw.id) : null,
    JobTitle: raw.title || null,
    Company: raw.company_name || companyName,
    ApplicationURL: raw.careers_apply_url || raw.careers_url || null,
    DirectApplyURL: raw.careers_apply_url || null,
    Location: primaryLoc,
    AllLocations: allLocs,
    Department: raw.department || null,
    Team: null,
    Office: null,
    ContractType: EMPLOYMENT_MAP[raw.employment_type_code] || raw.employment_type_code || null,
    WorkplaceType: wp.workplaceType,
    IsRemote: wp.isRemote,
    Tags: Array.isArray(raw.tags) ? raw.tags : [],
    Description: descHtml,
    DescriptionPlain: descPlain,
    DescriptionLists: [],
    AdditionalInfo: [
      raw.category_code ? `Category: ${raw.category_code}` : null,
      raw.education_code ? `Education: ${raw.education_code}` : null,
    ].filter(Boolean).join(' | ') || null,
    SalaryMin: raw.salary?.min ?? null,
    SalaryMax: raw.salary?.max ?? null,
    SalaryCurrency: raw.salary?.currency || null,
    SalaryInterval: raw.salary?.period || null,
    SalaryInfo: null,
    ExperienceLevel: raw.experience_code || null,
    PostedDate: postedDate,
    sourceSite,
    ATSPlatform: 'recruitee',
    Status: 'active',
    scrapedAt: new Date(),
  };
}
