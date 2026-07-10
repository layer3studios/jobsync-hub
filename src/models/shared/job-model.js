// FILE: src/models/shared/job-model.js
// Pure-JS job factory. Previous version used Mongoose for schema + hooks,
// but `saveJobs` always wrote via the native driver bulkWrite, so hooks
// never actually fired — they were dead code. Removed.
//
// `ensureJobIndexes` is kept; it now creates indexes via the native driver.

import { col } from '../../Db/connection.js';
import { cleanJobDescription } from '../../core/cleanJobDescription/index.js';
import { generateJobTags, getPlainTextForTagging } from '../../core/jobTags/index.js';

/** Authoritative shape of a job document. Drives field defaults + casting. */
export const jobSchemaDefinition = {
  JobID: { type: String, required: true },
  sourceSite: { type: String, required: true },
  JobTitle: { type: String, required: true, trim: true },
  ApplicationURL: { type: String, required: true },
  Description: { type: String, default: '' },
  Location: { type: String, default: 'N/A' },
  Company: { type: String, default: 'N/A' },
  Status: { type: String, default: 'active' },
  Department: { type: String, default: 'N/A' },
  ContractType: { type: String, default: 'N/A' },
  ExperienceLevel: { type: String, default: 'N/A' },
  PostedDate: { type: Date, default: null },

  // ATS-provided
  DirectApplyURL: { type: String, default: null },
  Team: { type: String, default: null },
  AllLocations: { type: Array, default: [] },
  Tags: { type: Array, default: [] },
  WorkplaceType: { type: String, default: null },
  IsRemote: { type: Boolean, default: null },

  // Description variants
  DescriptionPlain: { type: String, default: null },
  DescriptionLists: { type: Array, default: [] },
  AdditionalInfo: { type: String, default: null },
  DescriptionCleaned: { type: String, default: null },

  // Salary
  SalaryMin: { type: Number, default: null },
  SalaryMax: { type: Number, default: null },
  SalaryCurrency: { type: String, default: null },
  SalaryInterval: { type: String, default: null },
  SalaryInfo: { type: String, default: null },

  // Misc
  Office: { type: String, default: null },
  ATSPlatform: { type: String, default: null },
  isEntryLevel: { type: Boolean, default: null },

  // Auto-generated tags
  autoTags: {
    techStack: { type: Array, default: [] },
    roleCategory: { type: String, default: 'Other' },
    experienceBand: { type: String, default: null },
    isEntryLevel: { type: Boolean, default: false },
    domain: { type: Array, default: [] },
    urgency: { type: String, default: null },
    education: { type: String, default: null },
  },
};

function isNestedDef(field) {
  return field && typeof field === 'object' && !Array.isArray(field) && !field.type;
}

function cast(field, value) {
  if (value === undefined || value === null) return field.default;

  if (isNestedDef(field)) {
    const src = value && typeof value === 'object' ? value : {};
    const out = {};
    for (const key of Object.keys(field)) out[key] = cast(field[key], src[key]);
    return out;
  }

  switch (field.type) {
    case String: {
      const s = String(value);
      return field.trim ? s.trim() : s;
    }
    case Number: {
      const n = Number(value);
      return Number.isNaN(n) ? field.default : n;
    }
    case Boolean:
      if (typeof value === 'string') return value === 'true';
      return Boolean(value);
    case Date: {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? field.default : d;
    }
    case Array:
      return Array.isArray(value) ? value : field.default;
    default:
      return value;
  }
}

function buildPayload(data = {}, siteName) {
  const payload = {
    createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
    updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
    scrapedAt: data.scrapedAt ? new Date(data.scrapedAt) : new Date(),
  };
  for (const key of Object.keys(jobSchemaDefinition)) {
    payload[key] = cast(jobSchemaDefinition[key], data[key]);
  }
  payload.sourceSite = payload.sourceSite || siteName;
  payload.Company = payload.Company || siteName || jobSchemaDefinition.Company.default;

  // Pre-compute cleaned description + auto tags
  if (payload.Description) {
    payload.DescriptionCleaned = cleanJobDescription(payload.Description);
    payload.DescriptionPlain = getPlainTextForTagging(payload);
    const tags = generateJobTags(payload);
    payload.autoTags = tags;
    payload.isEntryLevel = tags.isEntryLevel;
  }
  return payload;
}

/** Create a normalised job object ready for persistence. */
export const createJobModel = (mappedJob, siteName) =>
  buildPayload({ ...mappedJob, sourceSite: siteName, Company: mappedJob.Company || siteName }, siteName);

/**
 * Create an index, self-healing if an index with the same name already exists
 * with different options (e.g. leftover TTL from the old Mongoose schema).
 */
async function safeCreateIndex(coll, keys, options = {}) {
  try {
    await coll.createIndex(keys, options);
  } catch (err) {
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') {
      // Find the conflicting index by key shape and drop it, then recreate.
      const indexes = await coll.indexes();
      const keyJson = JSON.stringify(keys);
      const conflict = indexes.find(i => JSON.stringify(i.key) === keyJson);
      if (conflict) {
        console.warn(`[indexes] dropping conflicting index ${conflict.name} on ${coll.collectionName}`);
        await coll.dropIndex(conflict.name);
        await coll.createIndex(keys, options);
        return;
      }
    }
    throw err;
  }
}

/**
 * Uniqueness on JobID applies to scraped jobs ONLY. The `jobs` collection is
 * shared with native postings, which carry no JobID — and MongoDB indexes a
 * missing field as null, so a plain unique index would permit exactly one
 * native posting collection-wide. The filter keys off `sourceSite` (required on
 * every scraped job, absent on every native posting) because
 * partialFilterExpression forbids $ne and $exists:false.
 */
export const JOB_ID_UNIQUE_INDEX_NAME = 'jobs_JobID_unique_scraped';
export const JOB_ID_UNIQUE_INDEX_OPTIONS = {
  unique: true,
  partialFilterExpression: { sourceSite: { $exists: true } },
  name: JOB_ID_UNIQUE_INDEX_NAME,
};

/** Idempotent index setup. Called from server boot. */
export async function ensureJobIndexes() {
  const jobs = await col('jobs');
  await safeCreateIndex(jobs, { JobID: 1 }, JOB_ID_UNIQUE_INDEX_OPTIONS);
  await safeCreateIndex(jobs, { Status: 1, PostedDate: -1 });
  await safeCreateIndex(jobs, { Status: 1, Company: 1 });
  await safeCreateIndex(jobs, { Status: 1, 'autoTags.roleCategory': 1 });
  await safeCreateIndex(jobs, { Status: 1, 'autoTags.experienceBand': 1 });
  await safeCreateIndex(jobs, { scrapedAt: 1 });
  await safeCreateIndex(jobs, { ATSPlatform: 1 });
  await safeCreateIndex(jobs, { sourceSite: 1, JobID: 1 });
}
