// FILE: src/core/processor/mappers/workday.js
// Workday is unusual: most fields are filled later by siteConfig.getDetails().

export function mapWorkdayJob(raw, companyName, sourceSite) {
  let workplaceType = null;
  let isRemote = null;
  if (raw.remoteType && typeof raw.remoteType === 'string') {
    workplaceType = raw.remoteType.toLowerCase();
    isRemote = workplaceType === 'fully remote' || workplaceType === 'remote';
  } else if ((raw.locationsText || '').toLowerCase().includes('remote')) {
    workplaceType = 'remote';
    isRemote = true;
  }

  return {
    JobID: raw.bulletFields?.[0]
      ? `workday_${raw._company}_${raw.bulletFields[0]}`
      : null,
    JobTitle: raw.title || null,
    Company: companyName,
    ApplicationURL: null,
    DirectApplyURL: null,
    Location: raw.locationsText || null,
    AllLocations: raw.locationsText ? [raw.locationsText] : [],
    Department: null,
    Team: null,
    Office: null,
    ContractType: null,
    WorkplaceType: workplaceType,
    IsRemote: isRemote,
    Tags: [],
    Description: null,
    DescriptionPlain: null,
    DescriptionLists: [],
    AdditionalInfo: null,
    SalaryMin: null,
    SalaryMax: null,
    SalaryCurrency: null,
    SalaryInterval: null,
    SalaryInfo: null,
    PostedDate: null,
    sourceSite,
    ATSPlatform: 'workday',
    Status: 'active',
    scrapedAt: new Date(),
  };
}
