// FILE: src/Db/jobs/queries.js
// Read-side queries for the jobs collection. All return JSON-safe shapes.

import { ObjectId } from 'mongodb';
import { col } from '../connection.js';

const JOBS = 'jobs';

/**
 * Build the Mongo query for /api/jobs given a set of filters. Returns an
 * object suitable to pass directly to `find()` / `countDocuments()`.
 */
function buildJobsQuery({
  company, platform, workplace, entryLevel,
  roleCategory, experienceBand, techStack, dateFilter, searchFilter,
}) {
  const must = [{ Status: 'active' }];

  if (company?.trim()) {
    must.push({ Company: { $regex: company.trim(), $options: 'i' } });
  }

  if (platform?.trim()) {
    must.push({ ATSPlatform: platform.trim().toLowerCase() });
  }

  if (workplace?.trim()) {
    const wp = workplace.trim().toLowerCase();
    if (wp === 'remote') {
      must.push({ $or: [
        { WorkplaceType: { $regex: '^remote$', $options: 'i' } },
        { Location: { $regex: 'remote', $options: 'i' } },
        { JobTitle: { $regex: 'remote', $options: 'i' } },
        { IsRemote: true },
      ]});
    } else if (wp === 'hybrid') {
      must.push({ $or: [
        { WorkplaceType: { $regex: '^hybrid(?: job)?$', $options: 'i' } },
        { Location: { $regex: 'hybrid', $options: 'i' } },
        { JobTitle: { $regex: 'hybrid', $options: 'i' } },
      ]});
    } else if (wp === 'on-site') {
      must.push({ $or: [
        { WorkplaceType: { $regex: '^(?:on-site|onsite|onsite job)$', $options: 'i' } },
        { Location: { $regex: 'on.?site|in-office', $options: 'i' } },
        { JobTitle: { $regex: 'on.?site|in-office', $options: 'i' } },
      ]});
    }
  }

  if (roleCategory?.trim()) {
    must.push({ 'autoTags.roleCategory': roleCategory.trim() });
  }

  if (experienceBand?.trim()) {
    const isFresher = ['Fresher (0-1y)', 'fresher', 'Entry Level'].includes(experienceBand.trim());
    if (isFresher) {
      must.push({ $or: [
        { 'autoTags.experienceBand': experienceBand.trim() },
        { isEntryLevel: true },
      ]});
    } else {
      must.push({ 'autoTags.experienceBand': experienceBand.trim() });
    }
  } else if (entryLevel) {
    must.push({ $or: [
      { isEntryLevel: true },
      { 'autoTags.experienceBand': 'Fresher (0-1y)' },
    ]});
  }

  if (Array.isArray(techStack) && techStack.length > 0) {
    const clean = techStack.map(t => t.trim()).filter(Boolean);
    if (clean.length > 0) must.push({ 'autoTags.techStack': { $all: clean } });
  }

  if (dateFilter) {
    const days = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }[dateFilter];
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

/**
 * Paginated jobs feed used by /api/jobs.
 * Returns { jobs, totalJobs, totalPages, currentPage, companies }.
 */
export async function getJobsPaginated(
  page = 1, limit = 50, companyFilter = null, platformFilter = null,
  workplaceFilter = null, entryLevelFilter = null, roleCategoryFilter = null,
  experienceBandFilter = null, techStackFilter = [], dateFilter = null, searchFilter = null,
) {
  const jobs = await col(JOBS);
  const skip = (Math.max(1, page) - 1) * limit;
  const query = buildJobsQuery({
    company: companyFilter, platform: platformFilter, workplace: workplaceFilter,
    entryLevel: entryLevelFilter, roleCategory: roleCategoryFilter,
    experienceBand: experienceBandFilter, techStack: techStackFilter,
    dateFilter, searchFilter,
  });

  const [totalJobs, results, companies] = await Promise.all([
    jobs.countDocuments(query),
    jobs.find(query)
      .sort({ PostedDate: -1, scrapedAt: -1 })
      .skip(skip).limit(limit)
      .project({ __v: 0 })
      .toArray(),
    jobs.distinct('Company', { Status: 'active' }),
  ]);

  return {
    jobs: results,
    totalJobs,
    totalPages: Math.max(1, Math.ceil(totalJobs / limit)),
    currentPage: page,
    companies,
  };
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
  return jobs.find({ Status: 'active' })
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
  return jobs.findOne({ _id: new ObjectId(id) });
}
