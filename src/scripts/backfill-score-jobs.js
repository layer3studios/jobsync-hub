// FILE: src/scripts/backfill-score-jobs.js
// One-shot backfill for applications that were never scored (Q1 D7). Enqueues a
// score job for every application that has no resume_scores row, plus — with
// --force — those whose score row carries a processingError (retry the failures).
// Idempotent (R5): enqueueScoreJob skips applications that already have a job.
// Optionally scoped to one company by slug (C8). console.log is intentional here —
// this is a stdout maintenance CLI (C5).
// CLI: node src/scripts/backfill-score-jobs.js [--company-slug=SLUG] [--force] [--dry-run]

import { connectToDb, closeDb, col } from '../Db/connection.js';
import { enqueueScoreJob } from '../services/public/resume-score-queue-service.js';

function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return { force: flag('force'), dryRun: flag('dry-run'), companySlug: value('company-slug') };
}

/** Resolve --company-slug to a companyId, or null to run across all companies. */
async function resolveCompanyId(companySlug) {
  if (!companySlug) return null;
  const company = await (await col('companies')).findOne({ slug: companySlug });
  if (!company) {
    console.log(`[backfill-score] No company found for slug "${companySlug}".`);
    process.exitCode = 1;
    return undefined; // signal: stop
  }
  return company._id;
}

/** Applications needing scoring: no score row, or (force) a score row with an error. */
async function findCandidates(companyId, force) {
  const query = companyId ? { companyId } : {};
  const applications = await (await col('applications')).find(query).toArray();
  const scores = await col('resume_scores');
  const candidates = [];
  for (const app of applications) {
    const score = await scores.findOne({ applicationId: app._id });
    if (!score) { candidates.push(app); continue; }
    if (force && score.processingError) candidates.push(app);
  }
  return candidates;
}

async function main() {
  const { force, dryRun, companySlug } = parseArgs(process.argv.slice(2));
  await connectToDb();

  const companyId = await resolveCompanyId(companySlug);
  if (companyId === undefined) return; // unknown slug already reported

  const candidates = await findCandidates(companyId, force);
  console.log(`found ${candidates.length} applications needing scoring`);

  if (dryRun) {
    console.log('--dry-run: no jobs enqueued.');
    return;
  }

  let enqueued = 0;
  for (const app of candidates) {
    const result = await enqueueScoreJob(app._id, app.companyId, app.jobId);
    if (result.enqueued && !result.alreadyExisted) enqueued += 1;
  }
  console.log(`enqueued ${enqueued} jobs, ${candidates.length - enqueued} already had jobs`);
}

main()
  .catch((err) => { console.log(`[backfill-score] Fatal: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
