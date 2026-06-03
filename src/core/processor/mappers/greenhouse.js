// FILE: src/core/processor/mappers/greenhouse.js
// NOTE on PostedDate: the public Greenhouse boards API only exposes `updated_at`,
// which gets bumped every time the company edits the listing (description tweak,
// location change, etc.). Using it as PostedDate makes old jobs appear "Today".
// We deliberately set PostedDate to null and let the frontend fall back to
// our own createdAt (first time we saw the job) for display.

export function mapGreenhouseJob(raw, companyName, sourceSite) {
  let salaryInfo = null;
  if (Array.isArray(raw.metadata)) {
    const meta = raw.metadata.find(m =>
      m.name && (m.name.toLowerCase().includes('salary') || m.name.toLowerCase().includes('compensation')),
    );
    if (meta?.value) salaryInfo = String(meta.value);
  }

  const depts = Array.isArray(raw.departments) ? raw.departments : [];
  const offices = Array.isArray(raw.offices) ? raw.offices : [];
  const locName = (raw.location?.name || '').toLowerCase();

  let workplaceType = null;
  let isRemote = null;
  if (locName.includes('remote')) { workplaceType = 'remote'; isRemote = true; }
  else if (locName.includes('hybrid')) { workplaceType = 'hybrid'; isRemote = false; }
  else if (locName) { workplaceType = 'on-site'; isRemote = false; }

  const allLocs = offices.map(o => o.name).filter(Boolean);
  const descPlain = raw.content
    ? raw.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : null;

  return {
    JobID: String(raw.id || ''),
    JobTitle: raw.title || null,
    Company: companyName,
    ApplicationURL: raw.absolute_url || null,
    DirectApplyURL: null,
    Location: raw.location?.name || null,
    AllLocations: allLocs,
    Department: depts[0]?.name || null,
    Team: null,
    Office: offices[0]?.name || null,
    ContractType: null,
    WorkplaceType: workplaceType,
    IsRemote: isRemote,
    Tags: [],
    Description: raw.content || null,
    DescriptionPlain: descPlain,
    DescriptionLists: [],
    AdditionalInfo: null,
    SalaryMin: null,
    SalaryMax: null,
    SalaryCurrency: null,
    SalaryInterval: null,
    SalaryInfo: salaryInfo,
    PostedDate: null,
    sourceSite,
    ATSPlatform: 'greenhouse',
    Status: 'active',
    scrapedAt: new Date(),
  };
}
