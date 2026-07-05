// FILE: src/scripts/diagnose-resume-dedup.js
// Read-only diagnostic for the F1 resume-dedup fast path (FIX-01 B1). Reports
// which dedup fields the caller's user doc actually carries and cross-checks the
// stored hash against the most recent parse job, so a schema-drift bug (old doc
// missing lastResumeHash) is told apart from a live code bug (R3). NO writes.
// console.log is intentional — this is a stdout diagnostic CLI (C5).
// CLI: node src/scripts/diagnose-resume-dedup.js <userEmail>

import { connectToDb, closeDb, col } from '../Db/connection.js';

const first8 = (value) => (typeof value === 'string' && value ? `${value.slice(0, 8)}…` : null);
const iso = (value) => (value ? new Date(value).toISOString() : null);

function verdictFor({ hasProfile, docHash, jobHash }) {
  if (!hasProfile) return 'NO PROFILE YET';
  if (!docHash) return 'DEDUP DATA MISSING';
  if (jobHash && docHash !== jobHash) return 'HASH MISMATCH';
  return 'DEDUP SHOULD WORK';
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.log('Usage: node src/scripts/diagnose-resume-dedup.js <userEmail>');
    process.exitCode = 1;
    return;
  }

  await connectToDb();
  const users = await col('users');
  const user = await users.findOne({ email });
  if (!user) {
    console.log(`[diagnose] No user found for email ${email}`);
    return;
  }

  const jobs = await col('resume_parse_jobs');
  const recentJob = (await jobs.find({ userId: user._id }).sort({ createdAt: -1 }).limit(1).toArray())[0] || null;

  const hasProfile = Boolean(user.parsedProfile);
  const docHash = user.lastResumeHash || null;
  const jobHash = recentJob?.fileHash || null;

  console.log(`[diagnose] user: ${email} (${user._id})`);
  console.log(`[diagnose] has parsedProfile: ${hasProfile ? 'yes' : 'no'}${user.profileParsedAt ? ` (parsedAt=${iso(user.profileParsedAt)})` : ''}`);
  console.log(`[diagnose] has lastResumeHash: ${docHash ? `yes (${first8(docHash)})` : 'no'}`);
  console.log(`[diagnose] has profileUpdatedAt: ${user.profileUpdatedAt ? `yes (${iso(user.profileUpdatedAt)})` : 'no'}`);
  if (recentJob) {
    console.log(`[diagnose] recent job: status=${recentJob.status} hash=${first8(jobHash) ?? 'none'} createdAt=${iso(recentJob.createdAt) ?? 'n/a'} completedAt=${iso(recentJob.completedAt) ?? 'n/a'}`);
  } else {
    console.log('[diagnose] recent job: none');
  }

  console.log(`[diagnose] verdict: ${verdictFor({ hasProfile, docHash, jobHash })}`);
}

main()
  .catch((err) => { console.log(`[diagnose] Fatal: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
