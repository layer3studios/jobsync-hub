// FILE: src/core/processor/mappers/lever.js
import { validatePostedDate } from '../filters.js';

function normalizeWorkplace(wt) {
  if (!wt || wt === 'unspecified') return null;
  if (wt === 'onSite') return 'on-site';
  return wt;
}

export function mapLeverJob(raw, companyName, sourceSite) {
  const cats = raw.categories || {};
  const salary = raw.salaryRange || {};
  const postedDate = raw.createdAt ? validatePostedDate(raw.createdAt, `Lever/${raw.id}`) : null;

  return {
    JobID: raw.id || null,
    JobTitle: raw.text || null,
    Company: companyName,
    ApplicationURL: raw.hostedUrl || raw.applyUrl || null,
    DirectApplyURL: raw.applyUrl || null,
    Location: cats.location || null,
    AllLocations: Array.isArray(cats.allLocations) ? cats.allLocations : [],
    Department: cats.department || null,
    Team: cats.team || null,
    ContractType: cats.commitment || null,
    WorkplaceType: normalizeWorkplace(raw.workplaceType),
    IsRemote: raw.workplaceType === 'remote'
      ? true
      : (raw.workplaceType && raw.workplaceType !== 'unspecified' ? false : null),
    Tags: Array.isArray(raw.tags) ? raw.tags : [],
    Description: raw.description || null,
    DescriptionPlain: raw.descriptionPlain || null,
    DescriptionLists: Array.isArray(raw.lists) ? raw.lists : [],
    AdditionalInfo: raw.additional || null,
    SalaryMin: salary.min ?? null,
    SalaryMax: salary.max ?? null,
    SalaryCurrency: salary.currency || null,
    SalaryInterval: salary.interval || null,
    SalaryInfo: null,
    PostedDate: postedDate,
    sourceSite,
    ATSPlatform: 'lever',
    Status: 'active',
    scrapedAt: new Date(),
  };
}
