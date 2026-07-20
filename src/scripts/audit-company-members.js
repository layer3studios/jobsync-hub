// FILE: src/scripts/audit-company-members.js
// Read-only audit of the company_members backfill (feat/team-invites chunk 1).
// Reports founder coverage, duplicates, role distribution, and founder-vs-owner
// drift. Safe to run anytime (C9). console.log is intentional — stdout CLI (C5).
// CLI: node src/scripts/audit-company-members.js

import { pathToFileURL } from 'node:url';
import { connectToDb, closeDb, col } from '../Db/connection.js';

export async function main() {
  await connectToDb();
  const companiesCol = await col('companies');
  const membersCol = await col('company_members');

  const totalCompanies = await companiesCol.countDocuments({});
  const totalMembers = await membersCol.countDocuments({});

  // Founder count per company → how many have 0 or >1 founders.
  const foundersByCompany = await membersCol.aggregate([
    { $match: { isFounder: true } },
    { $group: { _id: '$companyId', count: { $sum: 1 } } },
  ]).toArray();
  const companiesWithFounder = new Set(foundersByCompany.map((row) => row._id.toString()));
  const companiesWithZeroFounders = totalCompanies - companiesWithFounder.size;
  const companiesWithMultipleFounders = foundersByCompany.filter((row) => row.count > 1).length;

  // Role distribution.
  const roleRows = await membersCol.aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ]).toArray();
  const roleDistribution = Object.fromEntries(roleRows.map((row) => [row._id, row.count]));

  // Duplicate (companyId, employerUserId) pairs — should be 0 (unique index).
  const dupPairs = await membersCol.aggregate([
    { $group: { _id: { companyId: '$companyId', employerUserId: '$employerUserId' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  // Founder drift: founder rows whose employerUserId != companies.claimedByEmployerUserId.
  let founderDrift = 0;
  for (const founder of await membersCol.find({ isFounder: true }).toArray()) {
    const company = await companiesCol.findOne({ _id: founder.companyId }, { projection: { claimedByEmployerUserId: 1 } });
    const owner = company?.claimedByEmployerUserId;
    if (!owner || owner.toString() !== founder.employerUserId.toString()) founderDrift += 1;
  }

  const report = {
    totalCompanies,
    companiesWithZeroFounders,
    companiesWithMultipleFounders,
    totalMembers,
    roleDistribution,
    duplicatePairs: dupPairs.length,
    founderOwnerDrift: founderDrift,
  };

  console.log('[audit] company_members');
  console.log(`  total_companies            : ${report.totalCompanies}`);
  console.log(`  companies_zero_founders    : ${report.companiesWithZeroFounders}  (expect 0 after backfill)`);
  console.log(`  companies_multi_founders   : ${report.companiesWithMultipleFounders}  (expect 0)`);
  console.log(`  total_company_members      : ${report.totalMembers}`);
  console.log(`  role_distribution          : ${JSON.stringify(report.roleDistribution)}`);
  console.log(`  duplicate_pairs            : ${report.duplicatePairs}  (expect 0)`);
  console.log(`  founder_vs_owner_drift     : ${report.founderOwnerDrift}  (expect 0 immediately after backfill)`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .catch((err) => { console.log(`[audit] Fatal: ${err.message}`); process.exitCode = 1; })
    .finally(async () => { await closeDb(); });
}
