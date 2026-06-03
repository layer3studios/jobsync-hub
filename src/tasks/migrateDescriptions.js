// FILE: src/tasks/migrateDescriptions.js
// One-time migration: run cleanJobDescription() across all jobs that have a
// Description but no DescriptionCleaned. Safe to re-run.
//
// Usage:  node src/tasks/migrateDescriptions.js

import { connectToDb, closeDb } from '../Db/connection.js';
import { cleanJobDescription } from '../core/cleanJobDescription/index.js';

async function run() {
  console.log('[migrate] connecting');
  const db = await connectToDb();
  const col = db.collection('jobs');

  const cursor = col.find(
    {
      Description: { $exists: true, $ne: null, $ne: '' },
      DescriptionCleaned: { $in: [null, undefined] },
    },
    { projection: { _id: 1, Description: 1 } },
  );

  let processed = 0;
  let errors = 0;

  while (await cursor.hasNext()) {
    const job = await cursor.next();
    try {
      const cleaned = cleanJobDescription(job.Description);
      await col.updateOne({ _id: job._id }, { $set: { DescriptionCleaned: cleaned } });
      processed++;
      if (processed % 50 === 0) console.log(`[migrate] ${processed} processed`);
    } catch (err) {
      console.error(`[migrate] ${job._id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[migrate] done. processed=${processed} errors=${errors}`);
  await closeDb();
  process.exit(0);
}

run().catch(err => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
