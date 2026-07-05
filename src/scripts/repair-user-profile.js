// FILE: src/scripts/repair-user-profile.js
// One-shot repair (FIX-02 D4) for a seeker whose user doc never received the
// parsed profile from a completed resume_parse_jobs row — the PROFILE_WRITE_MISSED
// silent-drift bug. Finds the user by email, then their most recent 'done' job
// whose result.profile exists, and writes result.profile + fileHash + timestamps
// onto the user doc by _id only (C8 — match by email, write by _id; no batch, no
// wildcard). NOT invoked automatically — run per account.
// console.log is intentional — this is a stdout maintenance CLI (C5).
// CLI: node src/scripts/repair-user-profile.js <userEmail> [--dry-run]

import { connectToDb, closeDb, col } from '../Db/connection.js';

const first8 = (value) => (typeof value === 'string' && value ? `${value.slice(0, 8)}…` : 'none');
const iso = (value) => (value ? new Date(value).toISOString() : 'none');
const nameOf = (profile) => (profile && profile.fullName ? profile.fullName : 'none');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const email = argv.find((arg) => !arg.startsWith('--'));
  if (!email) {
    console.log('Usage: node src/scripts/repair-user-profile.js <userEmail> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  await connectToDb();
  const users = await col('users');
  const user = await users.findOne({ email });
  if (!user) {
    console.log(`[repair] No user found for email ${email}`);
    return;
  }

  console.log(`[repair] before: lastResumeHash=${first8(user.lastResumeHash)} profileUpdatedAt=${iso(user.profileUpdatedAt)} fullName=${nameOf(user.parsedProfile)}`);

  const jobs = await col('resume_parse_jobs');
  const doneJob = (await jobs
    .find({ userId: user._id, status: 'done', 'result.profile': { $exists: true } })
    .sort({ completedAt: -1 })
    .limit(1)
    .toArray())[0] || null;
  if (!doneJob || !doneJob.result || !doneJob.result.profile) {
    console.log('[repair] no completed parse to repair from');
    return;
  }

  const setOps = {
    parsedProfile: doneJob.result.profile,
    lastResumeHash: doneJob.fileHash,
    profileParsedAt: doneJob.completedAt || new Date(),
    profileUpdatedAt: new Date(),
  };

  if (dryRun) {
    console.log(`[repair] --dry-run: would set lastResumeHash=${first8(setOps.lastResumeHash)} fullName=${nameOf(setOps.parsedProfile)} from job ${doneJob._id}`);
    return;
  }

  const result = await users.updateOne({ _id: user._id }, { $set: setOps });
  const after = await users.findOne(
    { _id: user._id },
    { projection: { lastResumeHash: 1, profileUpdatedAt: 1, parsedProfile: 1 } },
  );
  console.log(`[repair] after: lastResumeHash=${first8(after.lastResumeHash)} profileUpdatedAt=${iso(after.profileUpdatedAt)} fullName=${nameOf(after.parsedProfile)}`);
  console.log(`[repair] matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`);
}

main()
  .catch((err) => { console.log(`[repair] Fatal: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
