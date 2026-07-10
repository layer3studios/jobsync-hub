// FILE: src/scripts/audit-jobs-jobid-index.js
// READ-ONLY pre-flight audit for repair-jobs-jobid-index.js (STEP-PREFLIGHT).
//
// The repair script creates a unique partial index on { JobID: 1 } filtered to
// { sourceSite: { $exists: true } }. Docs matching that filter ARE indexed even
// when JobID is null or missing — MongoDB indexes a missing field as null. So if
// TWO OR MORE scraped rows lack a JobID, createIndex itself fails with E11000 and
// the migration aborts. Same for two or more rows sharing JobID: ''.
//
// This script answers "will the migration succeed?" without touching anything.
// No writes, no index changes. console.log is intentional — stdout maintenance
// CLI, not runtime code (C5).
// CLI: node src/scripts/audit-jobs-jobid-index.js

import { pathToFileURL } from 'node:url';
import { connectToDb, closeDb, col } from '../Db/connection.js';
import { JOB_ID_UNIQUE_INDEX_NAME } from '../models/shared/job-model.js';

const TAG = '[audit-jobid]';

/** Scraped rows whose JobID is null or absent — the migration's blocking case. */
const MISSING_JOB_ID_QUERY = {
  sourceSite: { $exists: true },
  $or: [{ JobID: null }, { JobID: { $exists: false } }],
};
/** Scraped rows with an empty-string JobID — duplicates of each other. */
const EMPTY_JOB_ID_QUERY = { sourceSite: { $exists: true }, JobID: '' };

/** True for an index keyed on exactly { JobID: 1 } — never the sourceSite compound. */
function isSoleJobIdKey(index) {
  const keys = Object.keys(index.key || {});
  return keys.length === 1 && keys[0] === 'JobID' && index.key.JobID === 1;
}

/** The five counts from D1. */
async function collectCounts(jobs) {
  return {
    totalDocuments: await jobs.countDocuments({}),
    scrapedDocuments: await jobs.countDocuments({ sourceSite: { $exists: true } }),
    nativePostings: await jobs.countDocuments({ source: 'native' }),
    scrapedMissingJobId: await jobs.countDocuments(MISSING_JOB_ID_QUERY),
    scrapedEmptyJobId: await jobs.countDocuments(EMPTY_JOB_ID_QUERY),
  };
}

function printCounts(counts) {
  const rows = [
    ['total documents in jobs', counts.totalDocuments],
    ['scraped documents (sourceSite exists)', counts.scrapedDocuments],
    ["native postings (source:'native')", counts.nativePostings],
    ['scraped with JobID null OR missing', counts.scrapedMissingJobId],
    ["scraped with JobID === ''", counts.scrapedEmptyJobId],
  ];
  console.log(`${TAG} counts:`);
  for (const [label, value] of rows) {
    console.log(`${TAG}   ${label.padEnd(40)} ${String(value).padStart(8)}`);
  }
}

/** Print every { JobID: 1 } index with its full options, plus the rest by name. */
function printIndexes(indexes) {
  const jobIdIndexes = indexes.filter(isSoleJobIdKey);
  console.log(`${TAG} all indexes on jobs: ${indexes.map((index) => index.name).join(', ')}`);
  console.log(`${TAG} { JobID: 1 } indexes found: ${jobIdIndexes.length}`);
  for (const index of jobIdIndexes) {
    console.log(`${TAG}   - ${index.name}: ${JSON.stringify(index)}`);
  }
  return jobIdIndexes;
}

/** Up to 5 offending docs so a human can eyeball them (D5). */
async function printOffendingDocuments(jobs, count) {
  if (count === 0) return;
  const sample = await jobs.find(MISSING_JOB_ID_QUERY)
    .project({ _id: 1, sourceSite: 1, JobTitle: 1 }).limit(5).toArray();
  console.log(`${TAG} sample of scraped docs missing JobID (showing ${sample.length} of ${count}):`);
  for (const doc of sample) {
    console.log(`${TAG}   _id=${doc._id} sourceSite=${doc.sourceSite} JobTitle=${doc.JobTitle ?? 'N/A'}`);
  }
  if (count > sample.length) console.log(`${TAG}   ... and ${count - sample.length} more`);
}

/**
 * SAFE when at most one scraped doc lacks a JobID, no scraped doc has an empty
 * JobID, and no more than one sole-{JobID:1} index exists. Returns the blockers.
 */
function evaluateVerdict(counts, jobIdIndexes) {
  const blockers = [];
  if (counts.scrapedMissingJobId > 1) {
    blockers.push({
      reason: `${counts.scrapedMissingJobId} scraped docs have JobID null/missing; the unique partial index allows at most 1`,
      query: `db.jobs.find(${JSON.stringify(MISSING_JOB_ID_QUERY)})`,
    });
  }
  if (counts.scrapedEmptyJobId > 0) {
    blockers.push({
      reason: `${counts.scrapedEmptyJobId} scraped docs have JobID === '' (these collide with each other)`,
      query: `db.jobs.find(${JSON.stringify(EMPTY_JOB_ID_QUERY)})`,
    });
  }
  if (jobIdIndexes.length > 1) {
    const names = jobIdIndexes.map((index) => index.name).join(', ');
    blockers.push({
      reason: `${jobIdIndexes.length} indexes on { JobID: 1 } (${names}) — expected at most 1`,
      query: 'db.jobs.getIndexes()',
    });
  }
  return blockers;
}

function printVerdict(blockers, jobIdIndexes) {
  console.log('');
  if (blockers.length === 0) {
    console.log(`${TAG} VERDICT: SAFE TO RUN repair-jobs-jobid-index.js`);
    const alreadyDone = jobIdIndexes.some((index) => index.name === JOB_ID_UNIQUE_INDEX_NAME);
    if (alreadyDone) console.log(`${TAG} note: ${JOB_ID_UNIQUE_INDEX_NAME} already exists; repair will be a no-op or drop leftovers`);
    return;
  }
  console.log(`${TAG} VERDICT: DO NOT RUN MIGRATION YET`);
  console.log(`${TAG} clean these first (${blockers.length}):`);
  blockers.forEach((blocker, position) => {
    console.log(`${TAG}   ${position + 1}. ${blocker.reason}`);
    console.log(`${TAG}      inspect with: ${blocker.query}`);
  });
}

/** Read-only audit. Prints findings; never throws on a finding (C8). */
export async function auditJobsJobIdIndex() {
  const jobs = await col('jobs');
  const counts = await collectCounts(jobs);
  printCounts(counts);

  const jobIdIndexes = printIndexes(await jobs.indexes());
  await printOffendingDocuments(jobs, counts.scrapedMissingJobId);

  const blockers = evaluateVerdict(counts, jobIdIndexes);
  printVerdict(blockers, jobIdIndexes);
  return { counts, blockers, safe: blockers.length === 0 };
}

async function main() {
  await connectToDb();
  await auditJobsJobIdIndex();
}

// Run only when invoked directly, so this can be imported without side effects.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((err) => { console.error(`${TAG} Fatal: ${err.message}`); process.exitCode = 1; })
    .finally(async () => { await closeDb(); });
}
