// FILE: src/Db/jobs/queries.js
// Read-side queries for the jobs collection. All return JSON-safe shapes.

import { ObjectId } from 'mongodb';
import { col } from '../connection.js';

const JOBS = 'jobs';

/**
 * Admin-hidden jobs are excluded from every seeker-facing read below.
 * `{ adminHiddenAt: null }` matches documents where the field is null OR
 * absent, so the existing corpus needs no backfill. This is the ONLY hook the
 * admin job browser has into the seeker read path — hiding never touches
 * `Status` (which means expired/inactive) or a native posting's `status`
 * (which belongs to the employer).
 */
export const NOT_ADMIN_HIDDEN = { adminHiddenAt: null };

/**
 * Build the Mongo query for /api/jobs given a set of filters. Returns an
 * object suitable to pass directly to `find()` / `countDocuments()`.
 */
/** Per-mode $or clause. Each mode matches the structured field first, then
 *  falls back to text hints for scraped jobs where WorkplaceType is unset. */
function workplaceClause(mode) {
  if (mode === 'remote') {
    return { $or: [
      { WorkplaceType: { $regex: '^remote$', $options: 'i' } },
      { IsRemote: true },
      { Location: { $regex: '\\bremote\\b', $options: 'i' } },
      { JobTitle: { $regex: '\\bremote\\b', $options: 'i' } },
    ]};
  }
  if (mode === 'hybrid') {
    return { $or: [
      { WorkplaceType: { $regex: '^hybrid(?: job)?$', $options: 'i' } },
      { Location: { $regex: '\\bhybrid\\b', $options: 'i' } },
      { JobTitle: { $regex: '\\bhybrid\\b', $options: 'i' } },
    ]};
  }
  if (mode === 'on-site') {
    return { $or: [
      { WorkplaceType: { $regex: '^(?:on-site|onsite|onsite job|office)$', $options: 'i' } },
      { Location: { $regex: 'on.?site|in-office', $options: 'i' } },
      { JobTitle: { $regex: 'on.?site|in-office', $options: 'i' } },
    ]};
  }
  return null;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildJobsQuery({
  company, workplace, entryLevel,
  roleCategory, experienceBand, techStack, dateFilter, searchFilter,
  locations, salaryMinLpa, salaryMaxLpa,
}) {
  const must = [{ Status: 'active' }, NOT_ADMIN_HIDDEN];

  if (company?.trim()) {
    must.push({ Company: { $regex: escapeRegex(company.trim()), $options: 'i' } });
  }

  // workplace: single value or comma/array of modes — OR within the category.
  const wpModes = (Array.isArray(workplace) ? workplace : (workplace ? workplace.split(',') : []))
    .map(w => w.trim().toLowerCase()).filter(Boolean);
  if (wpModes.length > 0) {
    const clauses = wpModes.map(workplaceClause).filter(Boolean);
    if (clauses.length === 1) must.push(clauses[0]);
    else if (clauses.length > 1) must.push({ $or: clauses });
  }

  if (roleCategory?.trim()) {
    must.push({ 'autoTags.roleCategory': roleCategory.trim() });
  }

  // experienceBand: single value or comma/array of bands — OR within the category.
  const expBands = (Array.isArray(experienceBand) ? experienceBand : (experienceBand ? experienceBand.split(',') : []))
    .map(b => b.trim()).filter(Boolean);
  if (expBands.length > 0) {
    const or = expBands.map(band =>
      ['Fresher (0-1y)', 'fresher', 'Entry Level'].includes(band)
        ? { $or: [{ 'autoTags.experienceBand': band }, { isEntryLevel: true }] }
        : { 'autoTags.experienceBand': band });
    must.push(or.length === 1 ? or[0] : { $or: or });
  } else if (entryLevel) {
    must.push({ $or: [
      { isEntryLevel: true },
      { 'autoTags.experienceBand': 'Fresher (0-1y)' },
    ]});
  }

  // techStack: OR within the category (standard job-site pattern).
  if (Array.isArray(techStack) && techStack.length > 0) {
    const clean = techStack.map(t => t.trim()).filter(Boolean);
    if (clean.length > 0) must.push({ 'autoTags.techStack': { $in: clean } });
  }

  // locations: OR across up to 5 cities, matched against Location + AllLocations.
  if (Array.isArray(locations) && locations.length > 0) {
    const cities = locations.map(c => c.trim()).filter(Boolean).slice(0, 5);
    if (cities.length > 0) {
      must.push({ $or: cities.flatMap(city => {
        const re = { $regex: `\\b${escapeRegex(city)}\\b`, $options: 'i' };
        return [{ Location: re }, { AllLocations: re }];
      })});
    }
  }

  // Salary range in LPA (INR lakhs/year). Only jobs that disclose a salary in
  // INR (or unspecified currency) on a yearly (or unspecified) interval match;
  // job range must overlap the requested range.
  const salMin = Number.isFinite(salaryMinLpa) && salaryMinLpa > 0 ? salaryMinLpa * 100000 : null;
  const salMax = Number.isFinite(salaryMaxLpa) && salaryMaxLpa > 0 ? salaryMaxLpa * 100000 : null;
  if (salMin !== null || salMax !== null) {
    must.push({ $or: [{ SalaryMin: { $ne: null } }, { SalaryMax: { $ne: null } }] });
    must.push({ SalaryCurrency: { $in: [null, 'INR', 'inr', 'Rs', '₹'] } });
    must.push({ SalaryInterval: { $in: [null, 'yearly', 'year', 'annual', 'annually', 'per annum'] } });
    if (salMin !== null) {
      must.push({ $or: [
        { SalaryMax: { $gte: salMin } },
        { SalaryMax: null, SalaryMin: { $gte: salMin } },
      ]});
    }
    if (salMax !== null) {
      must.push({ $or: [
        { SalaryMin: { $lte: salMax } },
        { SalaryMin: null, SalaryMax: { $lte: salMax } },
      ]});
    }
  }

  if (dateFilter) {
    // 'today'/'24h' are what the UI actually sends for the 24-hour bucket.
    const days = { today: 1, '24h': 1, '1d': 1, '3d': 3, '7d': 7, '30d': 30 }[dateFilter];
    if (days) {
      const since = new Date(Date.now() - days * 86400000);
      // FIX: fall back to createdAt/scrapedAt when PostedDate is null —
      // many ATS APIs do not provide it, and we were filtering them out entirely.
      must.push({ $or: [
        { PostedDate: { $gte: since } },
        { PostedDate: null, createdAt: { $gte: since } },
        { PostedDate: { $exists: false }, scrapedAt: { $gte: since } },
      ]});
    }
  }

  if (searchFilter && searchFilter.trim().length >= 2) {
    const escaped = searchFilter.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = { $regex: escaped, $options: 'i' };
    must.push({ $or: [
      { JobTitle: re },
      { Company: re },
      { Location: re },
      { 'autoTags.techStack': re },
      { Department: re },
    ]});
  }

  return must.length === 1 ? must[0] : { $and: must };
}

// The active-company list only changes when the scraper runs — no reason to
// recompute a distinct() on every feed request.
const COMPANIES_TTL_MS = 10 * 60 * 1000;
let companiesCache = { value: null, at: 0 };

async function getActiveCompaniesCached(jobs) {
  const now = Date.now();
  if (companiesCache.value && now - companiesCache.at < COMPANIES_TTL_MS) {
    return companiesCache.value;
  }
  const value = await jobs.distinct('Company', { Status: 'active', ...NOT_ADMIN_HIDDEN });
  companiesCache = { value, at: now };
  return value;
}

/**
 * Paginated jobs feed used by /api/jobs.
 * Returns { jobs, totalJobs, totalPages, currentPage, companies }.
 */
export async function getJobsPaginated(
  page = 1, limit = 50, companyFilter = null,
  workplaceFilter = null, entryLevelFilter = null, roleCategoryFilter = null,
  experienceBandFilter = null, techStackFilter = [], dateFilter = null, searchFilter = null,
  locationsFilter = [], salaryMinLpa = null, salaryMaxLpa = null,
) {
  const jobs = await col(JOBS);
  const skip = (Math.max(1, page) - 1) * limit;
  const query = buildJobsQuery({
    company: companyFilter, workplace: workplaceFilter,
    entryLevel: entryLevelFilter, roleCategory: roleCategoryFilter,
    experienceBand: experienceBandFilter, techStack: techStackFilter,
    dateFilter, searchFilter,
    locations: locationsFilter, salaryMinLpa, salaryMaxLpa,
  });

  const [totalJobs, results, companies] = await Promise.all([
    jobs.countDocuments(query),
    jobs.find(query)
      .sort({ PostedDate: -1, scrapedAt: -1 })
      .skip(skip).limit(limit)
      .project({ __v: 0 })
      .toArray(),
    getActiveCompaniesCached(jobs),
  ]);

  return {
    jobs: results,
    totalJobs,
    totalPages: Math.max(1, Math.ceil(totalJobs / limit)),
    currentPage: page,
    companies,
  };
}

// ─── Facets ─────────────────────────────────────────────────────────

const FACETS_TTL_MS = 30 * 60 * 1000;
let facetsCache = { value: null, at: 0 };

/** Words that show up as the first Location segment but are not cities. */
const NON_CITY_SEGMENTS = new Set([
  'remote', 'india', 'n/a', 'na', 'anywhere', 'multiple locations', 'pan india',
  'hybrid', 'on-site', 'onsite', 'work from home', 'wfh', '',
]);

function extractCity(raw) {
  if (typeof raw !== 'string') return null;
  // "Bengaluru, Karnataka, India" → "Bengaluru"; also split on "/" and "|".
  const seg = raw.split(/[,/|]/)[0].trim().replace(/\s+/g, ' ');
  if (seg.length < 2 || seg.length > 40) return null;
  if (NON_CITY_SEGMENTS.has(seg.toLowerCase())) return null;
  return seg;
}

/**
 * Filter facets for the /jobs page: top tech-stack tags and top posting
 * cities across active jobs. Heavily cached — aggregate freshness does not
 * matter minute-to-minute.
 */
export async function getJobFacets() {
  const now = Date.now();
  if (facetsCache.value && now - facetsCache.at < FACETS_TTL_MS) {
    return facetsCache.value;
  }

  const jobs = await col(JOBS);
  const [techAgg, locAgg] = await Promise.all([
    jobs.aggregate([
      { $match: { Status: 'active', ...NOT_ADMIN_HIDDEN, 'autoTags.techStack.0': { $exists: true } } },
      { $unwind: '$autoTags.techStack' },
      { $group: { _id: '$autoTags.techStack', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 30 },
    ]).toArray(),
    jobs.aggregate([
      { $match: { Status: 'active', ...NOT_ADMIN_HIDDEN } },
      { $group: { _id: '$Location', count: { $sum: 1 } } },
    ]).toArray(),
  ]);

  // Collapse raw Location strings into city counts (case-insensitive merge).
  const cityCounts = new Map();
  for (const { _id: locationString, count } of locAgg) {
    const city = extractCity(locationString);
    if (!city) continue;
    const key = city.toLowerCase();
    const entry = cityCounts.get(key);
    if (entry) entry.count += count;
    else cityCounts.set(key, { city, count });
  }
  const cities = [...cityCounts.values()]
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city))
    .slice(0, 30)
    .map(e => ({ city: e.city, count: e.count }));

  const value = {
    techStack: techAgg.map(t => ({ tag: t._id, count: t.count })),
    cities,
  };
  facetsCache = { value, at: now };
  return value;
}

/** Return up to 50 jobs for any list view that needs a simple paginated dump. */
export async function getAllJobs(page = 1, limit = 50) {
  const jobs = await col(JOBS);
  const skip = (Math.max(1, page) - 1) * limit;
  const [total, results] = await Promise.all([
    jobs.countDocuments(),
    jobs.find({}).sort({ PostedDate: -1, createdAt: -1 }).skip(skip).limit(limit).toArray(),
  ]);
  return {
    jobs: results,
    totalJobs: total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    currentPage: page,
  };
}

/** Return the 9 freshest active jobs for the unauthenticated landing page. */
export async function getPublicBaitJobs() {
  const jobs = await col(JOBS);
  return jobs.find({ Status: 'active', ...NOT_ADMIN_HIDDEN })
    .sort({ PostedDate: -1, createdAt: -1 })
    .limit(9)
    .project({
      JobTitle: 1, Company: 1, Location: 1, Department: 1,
      PostedDate: 1, ApplicationURL: 1,
    })
    .toArray();
}

/** Fetch a single job by its Mongo ObjectId string. */
export async function findJobById(id) {
  if (!ObjectId.isValid(id)) return null;
  const jobs = await col(JOBS);
  return jobs.findOne({ _id: new ObjectId(id), ...NOT_ADMIN_HIDDEN });
}
