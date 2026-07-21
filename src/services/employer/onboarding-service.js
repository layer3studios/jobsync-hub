// FILE: src/services/employer/onboarding-service.js
// Creates a Company, seeds its default stages + archive reasons, and links it
// onto the EmployerUser. No DB transactions are available (native driver, no
// sessions), so this is best-effort with cleanup on partial failure (R4): if
// anything after the company insert fails, the company + its seeds are removed
// and the user is left un-onboarded.
//
// The seed functions are injectable so the cleanup path can be tested without
// a real failure (mirrors the auth router's verifyToken injection).

import { col } from '../../Db/connection.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  getEmployerUserById,
  linkCompanyToEmployerUser,
  createCompany,
  toPublicCompany,
  seedDefaultStagesForCompany,
  seedDefaultArchiveReasonsForCompany,
  insertCompanyMember,
} from '../../models/employer/index.js';
import { validateName, validateOptionalUrl, validateRetentionDays } from './company-validators.js';

/** Remove a company and everything seeded for it (cleanup on partial failure). */
async function cleanupPartialCompany(companyId) {
  const stages = await col('stages');
  const archiveReasons = await col('archive_reasons');
  const companies = await col('companies');
  await stages.deleteMany({ companyId });
  await archiveReasons.deleteMany({ companyId });
  await companies.deleteOne({ _id: companyId });
}

export async function onboardEmployerCompany(input, deps = {}) {
  const {
    seedStages = seedDefaultStagesForCompany,
    seedArchiveReasons = seedDefaultArchiveReasonsForCompany,
    insertMember = insertCompanyMember,
    cleanup = cleanupPartialCompany,
  } = deps;
  const { employerUserId, name, website, retentionDays } = input;

  const user = await getEmployerUserById(employerUserId);
  if (!user) throw new HttpError(401, 'Unauthorized');
  if (user.companyId) {
    throw new HttpError(409, 'This account already has a company', 'ALREADY_ONBOARDED');
  }

  const cleanName = validateName(name);
  const cleanWebsite = validateOptionalUrl(website, 'INVALID_WEBSITE');
  const cleanRetentionDays = validateRetentionDays(retentionDays);

  const company = await createCompany(
    { name: cleanName, website: cleanWebsite, retentionDays: cleanRetentionDays },
    user._id,
  );

  try {
    await seedStages(company._id);
    await seedArchiveReasons(company._id);
    // The creator IS this company's Founder (matches the Chunk 1 backfill row shape).
    // Without this row every role-gated employer endpoint would 403 the new signup
    // with COMPANY_MEMBERSHIP_NOT_FOUND (Chunk 3.5 deploy-blocker fix). Founder = the
    // one row with isFounder:true; the model requires role:'founder' for that flag.
    await insertMember({
      companyId: company._id,
      employerUserId: user._id,
      role: 'founder',
      isFounder: true,
      canMoveApplicants: true,
      canArchiveApplicants: true,
      invitedByEmployerUserId: null,
      joinedAt: new Date(),
    });
    await linkCompanyToEmployerUser(user._id, company._id);
  } catch (err) {
    // Compensating write (no transactions available): remove the just-created company
    // + its seeds so the account is left cleanly un-onboarded, then rethrow the REAL
    // error (D2). If the rollback itself fails, the DB is inconsistent — warn so the
    // company id can be repaired by hand (D3).
    try {
      await cleanup(company._id);
    } catch (cleanupErr) {
      console.warn(`[onboarding] rollback failed for company ${company._id}; manual repair needed: ${cleanupErr.message}`);
    }
    throw err;
  }

  return { company: toPublicCompany(company) };
}
