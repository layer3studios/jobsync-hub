// FILE: src/scripts/repair-jobs-jobid-index.js
// One-off production repair for the JobID:null collision (STEP-FIX-JOBID-INDEX).
//
// The shared `jobs` collection historically carried a PLAIN unique index on
// { JobID: 1 }. Native postings have no JobID, MongoDB indexes a missing field
// as null, so only ONE native posting could ever exist collection-wide. The fix
// is a partial index restricted to scraped jobs (they alone have `sourceSite`).
//
// This script is REQUIRED, not cosmetic: MongoDB treats same-key/different-
// partialFilterExpression as a DISTINCT index, so ensureJobIndexes() on boot
// adds the new index but never drops the legacy one — which keeps enforcing
// uniqueness on JobID:null. Only this script removes it.
//
// Idempotent (safe to re-run). console.log is intentional — stdout maintenance
// CLI, not runtime code (C5).
// CLI: node src/scripts/repair-jobs-jobid-index.js [--dry-run]

import { pathToFileURL } from 'node:url';
import { connectToDb, closeDb, col } from '../Db/connection.js';
import { JOB_ID_UNIQUE_INDEX_NAME, JOB_ID_UNIQUE_INDEX_OPTIONS } from '../models/shared/job-model.js';

const EXPECTED_FILTER = JOB_ID_UNIQUE_INDEX_OPTIONS.partialFilterExpression;

/** True for an index keyed on exactly { JobID: 1 } — never the compound one. */
function isSoleJobIdKey(index) {
  const keys = Object.keys(index.key || {});
  return keys.length === 1 && keys[0] === 'JobID' && index.key.JobID === 1;
}

/** True when the index is already the unique partial index we want. */
function isCorrectIndex(index) {
  return index.name === JOB_ID_UNIQUE_INDEX_NAME
    && index.unique === true
    && JSON.stringify(index.partialFilterExpression) === JSON.stringify(EXPECTED_FILTER);
}

/**
 * Drop any { JobID: 1 } index that is not the desired partial one, then create
 * the desired one if absent. Returns a summary of what changed.
 */
export async function repairJobsJobIdIndex({ dryRun = false } = {}) {
  const jobs = await col('jobs');
  const before = await jobs.indexes();
  const jobIdIndexes = before.filter(isSoleJobIdKey);

  const alreadyCorrect = jobIdIndexes.some(isCorrectIndex);
  const stale = jobIdIndexes.filter((index) => !isCorrectIndex(index));

  console.log(`[repair-jobid] existing indexes on jobs: ${before.map((i) => i.name).join(', ')}`);
  console.log(`[repair-jobid] { JobID: 1 } indexes found: ${jobIdIndexes.length}`);

  if (alreadyCorrect && stale.length === 0) {
    console.log('[repair-jobid] already correct, nothing to do');
    return { dropped: [], created: null, alreadyCorrect: true };
  }

  if (dryRun) {
    console.log(`[repair-jobid] --dry-run: would drop [${stale.map((i) => i.name).join(', ')}]`);
    console.log(`[repair-jobid] --dry-run: would create ${alreadyCorrect ? 'nothing' : JOB_ID_UNIQUE_INDEX_NAME}`);
    return { dropped: [], created: null, alreadyCorrect: false, dryRun: true };
  }

  const dropped = [];
  for (const index of stale) {
    await jobs.dropIndex(index.name);
    dropped.push(index.name);
    console.log(`[repair-jobid] dropped stale index ${index.name}`);
  }
  if (dropped.length === 0) console.log('[repair-jobid] dropped nothing');

  let created = null;
  if (!alreadyCorrect) {
    await jobs.createIndex({ JobID: 1 }, JOB_ID_UNIQUE_INDEX_OPTIONS);
    created = JOB_ID_UNIQUE_INDEX_NAME;
    console.log(`[repair-jobid] created ${created} (unique, partial on sourceSite)`);
  } else {
    console.log('[repair-jobid] created nothing (correct index already present)');
  }

  const after = (await jobs.indexes()).filter(isSoleJobIdKey);
  console.log(`[repair-jobid] final { JobID: 1 } indexes: ${JSON.stringify(after)}`);
  return { dropped, created, alreadyCorrect: false };
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  await connectToDb();
  await repairJobsJobIdIndex({ dryRun });
}

// Run only when invoked directly, so tests can import repairJobsJobIdIndex.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((err) => { console.log(`[repair-jobid] Fatal: ${err.message}`); process.exitCode = 1; })
    .finally(async () => { await closeDb(); });
}
