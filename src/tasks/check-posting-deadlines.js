// FILE: src/tasks/check-posting-deadlines.js
// Closes native postings whose application deadline has passed and which asked to
// be closed automatically. Run directly:
//
//   node src/tasks/check-posting-deadlines.js
//
// IDEMPOTENT BY CONSTRUCTION. The query itself requires status:'active', so a
// second run the same day matches nothing: every posting the first run touched is
// now 'closed'. Nothing here reads a "last run" marker or a cursor, so running it
// twice, or never, or out of order, all converge on the same state.
//
// Deliberately narrow. It only ever flips active → closed on postings that opted
// in. It never reopens, never deletes, never emails, and never touches a posting
// with autoCloseOnDeadline false — a deadline without auto-close is a message to
// candidates (and a gate on the apply endpoint), not an instruction to us.

import { col, closeDb } from '../Db/connection.js';

const NATIVE = 'native';

/**
 * Close every eligible posting. Returns { closed, titles } so a caller (or a test)
 * can assert on the outcome rather than parsing logs.
 */
export async function checkPostingDeadlines(now = new Date()) {
  const postings = await col('jobs');

  // Each clause rules out one skip case named in the spec: non-native/scraped rows,
  // already-closed and draft postings, postings that never set a deadline, and
  // postings that set one but did not ask for auto-close.
  const query = {
    source: NATIVE,
    status: 'active',
    autoCloseOnDeadline: true,
    applicationDeadline: { $ne: null, $lte: now },
  };

  const due = await postings.find(query).project({ title: 1 }).toArray();
  if (due.length === 0) {
    console.log('[posting-deadlines] Closed 0 expired postings');
    return { closed: 0, titles: [] };
  }

  const result = await postings.updateMany(query, {
    $set: { status: 'closed', closedAt: now, updatedAt: now },
  });

  const titles = due.map((posting) => posting.title ?? '(untitled)');
  console.log(`[posting-deadlines] Closed ${result.modifiedCount} expired postings: ${titles.join(', ')}`);
  return { closed: result.modifiedCount, titles };
}

/**
 * Only when executed directly, never on import — so a test or a scheduler can pull
 * checkPostingDeadlines in without the process exiting underneath it.
 */
const isDirectRun = process.argv[1] && process.argv[1].endsWith('check-posting-deadlines.js');
if (isDirectRun) {
  checkPostingDeadlines()
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[posting-deadlines] failed: ${err.message}`);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
