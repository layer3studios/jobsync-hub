// FILE: src/tasks/diagnoseDates.js
// Diagnose date-field distributions in the jobs collection.
// Usage:  node src/tasks/diagnoseDates.js

import { connectToDb, closeDb } from '../Db/connection.js';

const DAY = 86400000;

async function run() {
  const db = await connectToDb();
  const jobs = db.collection('jobs');

  const now = new Date();
  const d1 = new Date(now.getTime() - 1 * DAY);
  const d7 = new Date(now.getTime() - 7 * DAY);
  const d14 = new Date(now.getTime() - 14 * DAY);
  const d30 = new Date(now.getTime() - 30 * DAY);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  JobMesh date-field diagnostic');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Now: ${now.toISOString()}\n`);

  // ── Totals ──────────────────────────────────────────────────────
  const total = await jobs.countDocuments({});
  const active = await jobs.countDocuments({ Status: 'active' });
  console.log(`Total jobs:       ${total}`);
  console.log(`Active jobs:      ${active}\n`);

  // ── createdAt distribution ──────────────────────────────────────
  console.log('createdAt distribution (active jobs):');
  console.log('  ─────────────────────────────────────');
  const cBuckets = await Promise.all([
    jobs.countDocuments({ Status: 'active', createdAt: { $gte: d1 } }),
    jobs.countDocuments({ Status: 'active', createdAt: { $gte: d7, $lt: d1 } }),
    jobs.countDocuments({ Status: 'active', createdAt: { $gte: d14, $lt: d7 } }),
    jobs.countDocuments({ Status: 'active', createdAt: { $gte: d30, $lt: d14 } }),
    jobs.countDocuments({ Status: 'active', createdAt: { $lt: d30 } }),
    jobs.countDocuments({ Status: 'active', createdAt: null }),
    jobs.countDocuments({ Status: 'active', createdAt: { $exists: false } }),
  ]);
  console.log(`  Last 24h:       ${cBuckets[0]}`);
  console.log(`  2-7 days ago:   ${cBuckets[1]}`);
  console.log(`  8-14 days ago:  ${cBuckets[2]}`);
  console.log(`  15-30 days ago: ${cBuckets[3]}`);
  console.log(`  > 30 days ago:  ${cBuckets[4]}`);
  console.log(`  NULL:           ${cBuckets[5]}`);
  console.log(`  MISSING:        ${cBuckets[6]}\n`);

  // ── PostedDate distribution ─────────────────────────────────────
  console.log('PostedDate distribution (active jobs):');
  console.log('  ─────────────────────────────────────');
  const pBuckets = await Promise.all([
    jobs.countDocuments({ Status: 'active', PostedDate: { $gte: d1 } }),
    jobs.countDocuments({ Status: 'active', PostedDate: { $gte: d7, $lt: d1 } }),
    jobs.countDocuments({ Status: 'active', PostedDate: { $gte: d14, $lt: d7 } }),
    jobs.countDocuments({ Status: 'active', PostedDate: { $gte: d30, $lt: d14 } }),
    jobs.countDocuments({ Status: 'active', PostedDate: { $lt: d30 } }),
    jobs.countDocuments({ Status: 'active', PostedDate: null }),
    jobs.countDocuments({ Status: 'active', PostedDate: { $exists: false } }),
  ]);
  console.log(`  Last 24h:       ${pBuckets[0]}`);
  console.log(`  2-7 days ago:   ${pBuckets[1]}`);
  console.log(`  8-14 days ago:  ${pBuckets[2]}`);
  console.log(`  15-30 days ago: ${pBuckets[3]}`);
  console.log(`  > 30 days ago:  ${pBuckets[4]}`);
  console.log(`  NULL:           ${pBuckets[5]}`);
  console.log(`  MISSING:        ${pBuckets[6]}\n`);

  // ── PostedDate null rate per ATS ────────────────────────────────
  console.log('PostedDate NULL rate per ATS:');
  console.log('  ─────────────────────────────────────');
  const perAts = await jobs.aggregate([
    { $match: { Status: 'active' } },
    { $group: {
      _id: '$ATSPlatform',
      total: { $sum: 1 },
      nullPosted: { $sum: { $cond: [{ $eq: ['$PostedDate', null] }, 1, 0] } },
    }},
    { $sort: { total: -1 } },
  ]).toArray();
  for (const a of perAts) {
    const pct = a.total > 0 ? Math.round((a.nullPosted / a.total) * 100) : 0;
    console.log(`  ${(a._id || 'unknown').padEnd(15)} total=${String(a.total).padStart(5)}  null=${String(a.nullPosted).padStart(5)}  (${pct}%)`);
  }
  console.log('');

  // ── Sanity: top companies by "newThisWeek using createdAt" ──────
  console.log('Top 10 companies by createdAt-based "new this week":');
  console.log('  ─────────────────────────────────────');
  const top = await jobs.aggregate([
    { $match: { Status: 'active', createdAt: { $gte: d7 } } },
    { $group: { _id: '$Company', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]).toArray();
  for (const t of top) {
    console.log(`  ${(t._id || '?').padEnd(45)} ${t.count}`);
  }
  console.log('');

  // ── Same top 10 but using PostedDate ────────────────────────────
  console.log('Top 10 companies by PostedDate-based "new this week":');
  console.log('  ─────────────────────────────────────');
  const topByPosted = await jobs.aggregate([
    { $match: { Status: 'active', PostedDate: { $gte: d7 } } },
    { $group: { _id: '$Company', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]).toArray();
  if (topByPosted.length === 0) {
    console.log('  (no jobs with PostedDate in the last 7 days)');
  } else {
    for (const t of topByPosted) {
      console.log(`  ${(t._id || '?').padEnd(45)} ${t.count}`);
    }
  }
  console.log('');

  await closeDb();
  process.exit(0);
}

run().catch(err => {
  console.error('[diagnose] fatal:', err);
  process.exit(1);
});
