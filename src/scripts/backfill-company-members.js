// FILE: src/scripts/backfill-company-members.js
// One-time (idempotent) migration for feat/team-invites chunk 1: give every existing
// company a Founder company_members row derived from its current single owner. Safe
// to run N times — the second run inserts 0 (C9). NOT run against prod by this repo;
// a human runs it on deploy (D5).
//
// NOTE: the owner link on companies is `claimedByEmployerUserId` in this codebase
// (the spec called it ownerEmployerUserId; the real field name is used here).
// console.log is intentional — this is a stdout maintenance CLI (C5).
// CLI: node src/scripts/backfill-company-members.js [--dry-run]

import { pathToFileURL } from 'node:url';
import { connectToDb, closeDb, col } from '../Db/connection.js';
import {
  ensureCompanyMemberIndexes, findFounderForCompany, insertCompanyMember,
} from '../models/employer/index.js';

export async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  await connectToDb();
  await ensureCompanyMemberIndexes();

  const companies = await (await col('companies')).find({}).toArray();
  const report = { total: companies.length, inserted: 0, skippedAlreadyHadFounder: 0, skippedOrphanNoOwner: 0, errors: 0 };

  for (const company of companies) {
    try {
      const ownerId = company.claimedByEmployerUserId;
      if (!ownerId) {
        report.skippedOrphanNoOwner += 1;
        console.log(`[backfill] company ${company._id} has no claimedByEmployerUserId — skipped (orphan)`);
        continue;
      }
      if (await findFounderForCompany(company._id)) {
        report.skippedAlreadyHadFounder += 1;
        continue;
      }
      if (dryRun) {
        report.inserted += 1; // count what WOULD be inserted
        continue;
      }
      await insertCompanyMember({
        companyId: company._id,
        employerUserId: ownerId,
        role: 'founder',
        isFounder: true,
        invitedByEmployerUserId: null,
        joinedAt: company.createdAt instanceof Date ? company.createdAt : new Date(),
      });
      report.inserted += 1;
    } catch (err) {
      // A concurrent/duplicate founder surfaces as E11000 — treat as already-had.
      if (err?.code === 11000) { report.skippedAlreadyHadFounder += 1; continue; }
      report.errors += 1;
      console.log(`[backfill] company ${company._id} errored: ${err.message}`);
    }
  }

  console.log(`[backfill] ${dryRun ? '(dry-run) ' : ''}done: total=${report.total} inserted=${report.inserted} skipped-already-had-founder=${report.skippedAlreadyHadFounder} skipped-orphan-no-owner=${report.skippedOrphanNoOwner} errors=${report.errors}`);
  return report;
}

// Auto-run only as the CLI entry, so importing (e.g. from a test) does not connect
// or close the shared DB. The CLI wrapper owns the connection lifecycle.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .catch((err) => { console.log(`[backfill] Fatal: ${err.message}`); process.exitCode = 1; })
    .finally(async () => { await closeDb(); });
}
