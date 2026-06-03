// FILE: src/core/processor/mappers/workable.js
import { validatePostedDate } from '../filters.js';

export function mapWorkableJob(raw, companyName, sourceSite) {
  let postedDate = raw.published_on ? validatePostedDate(raw.published_on, `Workable/${raw.shortcode}`) : null;
  if (!postedDate && raw.created_at) {
    postedDate = validatePostedDate(raw.created_at, `Workable/${raw.shortcode}/created_at`);
  }

  let workplaceType = null;
  let isRemote = null;
  const wt = raw.workplace_type;
  if (wt === 'remote') { workplaceType = 'remote'; isRemote = true; }
  else if (wt === 'hybrid') { workplaceType = 'hybrid'; isRemote = false; }
  else if (wt === 'on_site') { workplaceType = 'on-site'; isRemote = false; }
  else if (raw.telecommuting === true) { workplaceType = 'remote'; isRemote = true; }

  const location = [raw.city, raw.state, raw.country].filter(Boolean).join(', ') || null;
  const descPlain = raw.description
    ? raw.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : null;

  return {
    JobID: raw.shortcode || null,
    JobTitle: raw.title || null,
    Company: companyName,
    ApplicationURL: raw.application_url || raw.shortlink || raw.url || null,
    DirectApplyURL: raw.application_url || null,
    Location: location,
    AllLocations: location ? [location] : [],
    Department: raw.department || null,
    Team: null,
    Office: null,
    ContractType: raw.employment_type || null,
    WorkplaceType: workplaceType,
    IsRemote: isRemote,
    Tags: [],
    Description: raw.description || null,
    DescriptionPlain: descPlain,
    DescriptionLists: [],
    AdditionalInfo: [
      raw.experience ? `Experience: ${raw.experience}` : null,
      raw.education ? `Education: ${raw.education}` : null,
    ].filter(Boolean).join(' | ') || null,
    SalaryMin: null,
    SalaryMax: null,
    SalaryCurrency: null,
    SalaryInterval: null,
    SalaryInfo: null,
    PostedDate: postedDate,
    sourceSite,
    ATSPlatform: 'workable',
    Status: 'active',
    scrapedAt: new Date(),
  };
}
