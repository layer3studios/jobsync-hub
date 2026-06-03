// FILE: src/core/processor/mappers/ashby.js
import { validatePostedDate } from '../filters.js';

const EMPLOYMENT_MAP = {
  FullTime: 'Full-time', PartTime: 'Part-time', Intern: 'Internship',
  Temporary: 'Temporary', Contract: 'Contract',
};

export function mapAshbyJob(raw, companyName, sourceSite) {
  let postedDate = raw.publishedDate ? validatePostedDate(raw.publishedDate, `Ashby/${raw.id}`) : null;
  if (!postedDate && raw.createdAt) {
    postedDate = validatePostedDate(raw.createdAt, `Ashby/${raw.id}/createdAt`);
  }

  const allLocs = [];
  if (raw.location) allLocs.push(raw.location);
  if (Array.isArray(raw.secondaryLocations)) {
    for (const sec of raw.secondaryLocations) {
      if (sec.location && !allLocs.includes(sec.location)) allLocs.push(sec.location);
    }
  }

  let workplaceType = null;
  const locLower = (raw.location || '').toLowerCase();
  if (raw.isRemote === true) workplaceType = 'remote';
  else if (locLower.includes('hybrid')) workplaceType = 'hybrid';
  else if (raw.isRemote === false) workplaceType = 'on-site';

  return {
    JobID: raw.id || null,
    JobTitle: raw.title || null,
    Company: companyName,
    ApplicationURL: raw.jobUrl || null,
    DirectApplyURL: raw.applyUrl || null,
    Location: raw.location || null,
    AllLocations: allLocs,
    Department: raw.team?.name || null,
    Team: raw.team?.name || null,
    Office: null,
    ContractType: EMPLOYMENT_MAP[raw.employmentType] || raw.employmentType || null,
    WorkplaceType: workplaceType,
    IsRemote: raw.isRemote ?? null,
    Tags: [],
    Description: raw.descriptionHtml || null,
    DescriptionPlain: raw.descriptionPlain || null,
    DescriptionLists: [],
    AdditionalInfo: null,
    SalaryMin: null,
    SalaryMax: null,
    SalaryCurrency: null,
    SalaryInterval: null,
    SalaryInfo: raw.compensation?.compensationTierSummary || null,
    PostedDate: postedDate,
    sourceSite,
    ATSPlatform: 'ashby',
    Status: 'active',
    scrapedAt: new Date(),
  };
}
