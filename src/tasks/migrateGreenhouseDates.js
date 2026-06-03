// FILE: src/tasks/migrateGreenhouseDates.js
// One-time migration. Older Greenhouse jobs in the DB have PostedDate derived
// from `updated_at`, which is unreliable (bumps on every description edit).
// The new mapper sets PostedDate to null for Greenhouse — but existing rows
// aren't re-written by the scraper (it skips known JobIDs).
//
// This script nulls out PostedDate for all active Greenhouse jobs in the DB.
// After running, the UI will fall back to createdAt for display.
//
// Usage:  node src/tasks/migrateGreenhouseDates.js

import { connectToDb, closeDb } from '../Db/connection.js';

async function run() {
  console.log('[migrate-gh] connecting');
  const db = await connectToDb();
  const jobs = db.collection('jobs');

  const before = await jobs.countDocuments({
    ATSPlatform: 'greenhouse',
    PostedDate: { $ne: null },
  });
  console.log(`[migrate-gh] ${before} Greenhouse jobs currently have a PostedDate`);

  if (before === 0) {
    console.log('[migrate-gh] nothing to migrate');
    await closeDb();
    process.exit(0);
  }

  const result = await jobs.updateMany(
    { ATSPlatform: 'greenhouse' },
    { $set: { PostedDate: null } },
  );
  console.log(`[migrate-gh] cleared ${result.modifiedCount} PostedDate values`);

  await closeDb();
  process.exit(0);
}

run().catch(err => {
  console.error('[migrate-gh] fatal:', err);
  process.exit(1);
});
