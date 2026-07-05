// FILE: src/scripts/backfill-resume-hash.js
// One-shot repair for legacy seeker docs whose parsedProfile predates the F1
// hash write (FIX-01 D5). Copies the most recent completed parse job's fileHash
// onto the user's lastResumeHash (and backfills profileParsedAt from the job's
// completedAt when missing), so the dedup fast path works on the next upload
// without another parse round. NOT invoked automatically — run per account.
// console.log is intentional — this is a stdout maintenance CLI (C5).
// CLI: node src/scripts/backfill-resume-hash.js <userEmail> [--dry-run]

import { connectToDb, closeDb, col } from '../Db/connection.js';

const first8 = (value) => (typeof value === 'string' && value ? `${value.slice(0, 8)}…` : 'none');
const iso = (value) => (value ? new Date(value).toISOString() : 'none');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const email = argv.find((arg) => !arg.startsWith('--'));
  if (!email) {
    console.log('Usage: node src/scripts/backfill-resume-hash.js <userEmail> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  await connectToDb();
  const users = await col('users');
  const user = await users.findOne({ email });
  if (!user) {
    console.log(`[backfill] No user found for email ${email}`);
    return;
  }

  console.log(`[backfill] before: lastResumeHash=${first8(user.lastResumeHash)} profileParsedAt=${iso(user.profileParsedAt)}`);

  if (user.lastResumeHash) {
    console.log('[backfill] User already has lastResumeHash — nothing to backfill.');
    return;
  }

  const jobs = await col('resume_parse_jobs');
  const doneJob = (await jobs.find({ userId: user._id, status: 'done' }).sort({ completedAt: -1 }).limit(1).toArray())[0] || null;
  if (!doneJob || !doneJob.fileHash) {
    console.log('[backfill] No completed parse job with a fileHash — cannot backfill.');
    return;
  }

  const set = { lastResumeHash: doneJob.fileHash };
  if (!user.profileParsedAt && doneJob.completedAt) set.profileParsedAt = doneJob.completedAt;

  if (dryRun) {
    console.log(`[backfill] --dry-run: would set lastResumeHash=${first8(set.lastResumeHash)}${set.profileParsedAt ? ` profileParsedAt=${iso(set.profileParsedAt)}` : ''}`);
    return;
  }

  await users.updateOne({ _id: user._id }, { $set: set });
  const after = await users.findOne({ _id: user._id }, { projection: { lastResumeHash: 1, profileParsedAt: 1 } });
  console.log(`[backfill] after: lastResumeHash=${first8(after.lastResumeHash)} profileParsedAt=${iso(after.profileParsedAt)}`);
}

main()
  .catch((err) => { console.log(`[backfill] Fatal: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
