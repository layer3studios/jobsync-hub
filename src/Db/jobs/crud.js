// FILE: src/Db/jobs/crud.js
// Write-side operations for the jobs collection.

import { ObjectId } from 'mongodb';
import { col } from '../connection.js';
import { SITES_CONFIG } from '../../config.js';
import { createJobModel } from '../../models/jobModel.js';
import { cleanJobDescription } from '../../core/cleanJobDescription/index.js';
import { generateJobTags, getPlainTextForTagging } from '../../core/jobTags/index.js';

const JOBS = 'jobs';

/**
 * Delete jobs that the scraper no longer sees on a site (expired listings).
 * @param {string} siteName
 * @param {Set<string>} seenJobIds
 */
export async function deleteExpiredJobs(siteName, seenJobIds) {
  const jobs = await col(JOBS);
  const seen = Array.from(seenJobIds);
  const result = await jobs.deleteMany({
    sourceSite: siteName,
    JobID: { $nin: seen },
  });
  if (result.deletedCount > 0) {
    console.log(`[${siteName}] Deleted ${result.deletedCount} expired jobs.`);
  }
  return result.deletedCount;
}

/**
 * Fallback cleanup when a scrape fails partway through — anything older than
 * 7 days for that site is removed. Avoids wrongly deleting valid jobs.
 */
export async function deleteOldJobs(siteName) {
  const jobs = await col(JOBS);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  const result = await jobs.deleteMany({
    sourceSite: siteName,
    updatedAt: { $lt: sevenDaysAgo },
  });
  if (result.deletedCount > 0) {
    console.log(`[${siteName}] Deleted ${result.deletedCount} jobs older than 7 days.`);
  }
  return result.deletedCount;
}

/**
 * Load the set of existing JobIDs for every configured site. Runs the per-site
 * queries in parallel rather than serially.
 */
export async function loadAllExistingIDs() {
  const jobs = await col(JOBS);
  const map = new Map();
  await Promise.all(SITES_CONFIG.map(async (cfg) => {
    if (!cfg?.siteName) return;
    const docs = await jobs.find(
      { sourceSite: cfg.siteName },
      { projection: { JobID: 1 } },
    ).toArray();
    const ids = new Set(docs.map(d => d.JobID));
    map.set(cfg.siteName, ids);
    console.log(`[${cfg.siteName}] ${ids.size} existing jobs.`);
  }));
  return map;
}

/**
 * Bulk-upsert jobs. Dedupes by JobID within the input batch.
 * Re-runs description cleaning + autoTags before saving.
 */
export async function saveJobs(rawJobs) {
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) return 0;
  const jobs = await col(JOBS);

  const seen = new Set();
  const deduped = [];
  for (const j of rawJobs) {
    if (!j?.JobID || seen.has(j.JobID)) continue;
    seen.add(j.JobID);
    deduped.push(j);
  }
  if (deduped.length === 0) return 0;

  const ops = deduped.map(input => {
    const job = { ...input };

    if (job.Description) {
      job.DescriptionCleaned = cleanJobDescription(job.Description);
      job.DescriptionPlain = getPlainTextForTagging(job);
      const tags = generateJobTags(job);
      job.autoTags = tags;
      job.isEntryLevel = tags.isEntryLevel;
    }

    // Strip timestamps from $setOnInsert payload
    const { createdAt, updatedAt, scrapedAt, ...rest } = job;
    void createdAt; void updatedAt; void scrapedAt;

    const now = new Date();
    return {
      updateOne: {
        filter: { JobID: job.JobID },
        update: {
          $setOnInsert: {
            ...rest,
            createdAt: now,
            updatedAt: now,
            scrapedAt: now,
          },
        },
        upsert: true,
      },
    };
  });

  const result = await jobs.bulkWrite(ops, { ordered: false });
  return (result.upsertedCount || 0) + (result.modifiedCount || 0);
}

/** Delete a single job by ObjectId. Throws if id is not a valid ObjectId. */
export async function deleteJobById(id) {
  const jobs = await col(JOBS);
  const oid = id instanceof ObjectId ? id : new ObjectId(id);
  return jobs.deleteOne({ _id: oid });
}

/**
 * Admin-only: insert a manually curated job. Throws if required fields are
 * missing or if the ApplicationURL already exists.
 */
export async function addCuratedJob(data) {
  if (!data.JobTitle || !data.ApplicationURL || !data.Company) {
    throw new Error('Job Title, URL, and Company are required.');
  }
  const jobs = await col(JOBS);
  const exists = await jobs.findOne({ ApplicationURL: data.ApplicationURL });
  if (exists) throw new Error('This Application URL already exists in the database.');

  const jobToSave = createJobModel({
    JobID: `curated-${Date.now()}`,
    JobTitle: data.JobTitle,
    ApplicationURL: data.ApplicationURL,
    Company: data.Company,
    Location: data.Location,
    Department: data.Department,
    Description: data.Description || `Manually curated: ${data.JobTitle}`,
    PostedDate: data.PostedDate || new Date().toISOString(),
    ContractType: data.ContractType,
    ExperienceLevel: data.ExperienceLevel,
    isManual: true,
    Status: 'active',
  }, 'Curated');

  await saveJobs([jobToSave]);
  return jobToSave;
}
