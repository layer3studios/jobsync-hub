// FILE: src/Db/analytics/similarJobs.js
// "Similar jobs at other companies" — used in the job detail panel.

import { ObjectId } from 'mongodb';
import { col } from '../connection.js';

const PROJECTION = {
  JobTitle: 1, Company: 1, Location: 1, ApplicationURL: 1,
  PostedDate: 1, autoTags: 1, scrapedAt: 1,
};

/**
 * Find up to 8 active jobs at different companies that match the same
 * role category + experience band as the given job. Falls back to recent
 * jobs from other companies if no tagged matches exist.
 */
export async function getSimilarJobs(jobId) {
  if (!ObjectId.isValid(jobId)) return [];
  const jobs = await col('jobs');
  const oid = new ObjectId(jobId);

  const job = await jobs.findOne(
    { _id: oid },
    { projection: { Company: 1, autoTags: 1 } },
  );
  if (!job) return [];

  const baseQuery = {
    _id: { $ne: oid },
    Status: 'active',
    Company: { $ne: job.Company || '' },
  };

  // Build tag-matched query when tags are available
  const taggedQuery = { ...baseQuery };
  if (job.autoTags?.roleCategory) taggedQuery['autoTags.roleCategory'] = job.autoTags.roleCategory;
  if (job.autoTags?.experienceBand) taggedQuery['autoTags.experienceBand'] = job.autoTags.experienceBand;

  const results = await jobs.find(taggedQuery)
    .sort({ createdAt: -1, PostedDate: -1 })
    .limit(8)
    .project(PROJECTION)
    .toArray();

  if (results.length > 0) return results;

  // Fallback: any recent active jobs at other companies
  return jobs.find(baseQuery)
    .sort({ createdAt: -1 })
    .limit(8)
    .project(PROJECTION)
    .toArray();
}
