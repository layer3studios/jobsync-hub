// FILE: src/scripts/seed-initial-admins.js
// One-shot bootstrap for the admin_users collection. Reads INITIAL_ADMIN_EMAILS
// (comma-separated) and upserts each as a super_admin. Idempotent — safe to run
// repeatedly; existing rows keep their createdAt. NOT invoked on server boot.
// console.log is intentional — this is a stdout maintenance CLI (C5).
// CLI: node src/scripts/seed-initial-admins.js
//
// After a successful prod run, delete INITIAL_ADMIN_EMAILS from the prod .env.

import { connectToDb, closeDb } from '../Db/connection.js';
import { INITIAL_ADMIN_EMAILS } from '../env.js';
import { ensureAdminUserIndexes, upsertAdminByEmail } from '../models/admin/index.js';

async function main() {
  if (!INITIAL_ADMIN_EMAILS.length) {
    console.log('[seed-admins] No INITIAL_ADMIN_EMAILS set. Exiting.');
    return;
  }

  await connectToDb();
  await ensureAdminUserIndexes();

  let seeded = 0;
  for (const email of INITIAL_ADMIN_EMAILS) {
    const admin = await upsertAdminByEmail({
      email,
      role: 'super_admin',
      notes: 'Bootstrap admin (seed script)',
      invitedByAdminUserId: null,
    });
    seeded += 1;
    console.log(`[seed-admins] upserted ${admin.email} (role=${admin.role}, id=${admin._id})`);
  }

  console.log(`[seed-admins] Done. ${seeded} admin(s) seeded.`);
  console.log('[seed-admins] REMINDER: delete INITIAL_ADMIN_EMAILS from the prod .env now.');
}

main()
  .catch((err) => { console.log(`[seed-admins] Fatal: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
