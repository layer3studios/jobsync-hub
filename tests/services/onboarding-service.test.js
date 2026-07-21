// FILE: tests/services/onboarding-service.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes,
  findOrCreateEmployerGoogleUser, getEmployerUserById,
  listStagesForCompany, listArchiveReasonsForCompany,
  ensureCompanyMemberIndexes, findFounderForCompany,
} from '../../src/models/employer/index.js';
import { onboardEmployerCompany } from '../../src/services/employer/onboarding-service.js';

let userCounter = 0;
async function freshUser() {
  userCounter += 1;
  return findOrCreateEmployerGoogleUser({
    googleId: `g-${userCounter}`, email: `owner${userCounter}@acme.com`, name: 'Owner', picture: null,
  });
}

before(async () => {
  await dropCollections('companies', 'stages', 'archive_reasons', 'employer_users', 'company_members');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
});
beforeEach(async () => {
  await dropCollections('companies', 'stages', 'archive_reasons', 'employer_users', 'company_members');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
});
after(async () => { await closeTestDb(); });

test('happy path creates company, seeds 5 stages + 7 reasons, links the user', async () => {
  const user = await freshUser();
  const { company } = await onboardEmployerCompany({
    employerUserId: user._id.toString(), name: 'Acme Agency', website: 'https://acme.com', retentionDays: 180,
  });
  assert.equal(company.slug, 'acme-agency');
  assert.equal(company.retentionDays, 180);
  assert.equal((await listStagesForCompany(company.id)).length, 5);
  assert.equal((await listArchiveReasonsForCompany(company.id)).length, 7);
  const reloaded = await getEmployerUserById(user._id.toString());
  assert.equal(reloaded.companyId.toString(), company.id);
});

test('validation failures throw 400 with stable codes', async () => {
  const user = await freshUser();
  const id = user._id.toString();
  await assert.rejects(() => onboardEmployerCompany({ employerUserId: id, name: 'A' }),
    (err) => err.status === 400 && err.code === 'INVALID_NAME');
  await assert.rejects(() => onboardEmployerCompany({ employerUserId: id, name: 'Acme', website: 'ftp://x.com' }),
    (err) => err.status === 400 && err.code === 'INVALID_WEBSITE');
  await assert.rejects(() => onboardEmployerCompany({ employerUserId: id, name: 'Acme', retentionDays: 10 }),
    (err) => err.status === 400 && err.code === 'INVALID_RETENTION_DAYS');
});

test('a second onboarding for the same user is 409 ALREADY_ONBOARDED', async () => {
  const user = await freshUser();
  await onboardEmployerCompany({ employerUserId: user._id.toString(), name: 'Acme' });
  await assert.rejects(() => onboardEmployerCompany({ employerUserId: user._id.toString(), name: 'Acme' }),
    (err) => err.status === 409 && err.code === 'ALREADY_ONBOARDED');
});

test('a failure after the company insert cleans up and leaves the user un-onboarded', async () => {
  const user = await freshUser();
  const throwingSeedStages = () => { throw new Error('boom'); };
  await assert.rejects(
    () => onboardEmployerCompany({ employerUserId: user._id.toString(), name: 'Acme' }, { seedStages: throwingSeedStages }),
    (err) => err.message === 'boom',
  );
  assert.equal(await (await col('companies')).countDocuments({}), 0);
  assert.equal(await (await col('stages')).countDocuments({}), 0);
  assert.equal(await (await col('archive_reasons')).countDocuments({}), 0);
  const reloaded = await getEmployerUserById(user._id.toString());
  assert.equal(reloaded.companyId, null);
});

// ── Chunk 3.5: onboarding creates the Founder membership ─────────────────────

test('onboarding creates a Founder membership with the expected shape', async () => {
  const user = await freshUser();
  const { company } = await onboardEmployerCompany({ employerUserId: user._id.toString(), name: 'Founders Inc' });
  const founder = await findFounderForCompany(company.id);
  assert.ok(founder, 'a Founder membership row exists');
  assert.equal(founder.employerUserId.toString(), user._id.toString());
  assert.equal(founder.role, 'founder');
  assert.equal(founder.isFounder, true);
  assert.equal(founder.canMoveApplicants, true);
  assert.equal(founder.canArchiveApplicants, true);
  assert.equal(founder.invitedByEmployerUserId, null);
  assert.ok(founder.joinedAt instanceof Date);
  assert.equal(await (await col('company_members')).countDocuments({}), 1);
});

test('membership insert failure rolls back the company (compensating write)', async () => {
  const user = await freshUser();
  const throwingInsertMember = () => { throw new Error('member insert boom'); };
  await assert.rejects(
    () => onboardEmployerCompany({ employerUserId: user._id.toString(), name: 'Acme' }, { insertMember: throwingInsertMember }),
    (err) => err.message === 'member insert boom',
  );
  assert.equal(await (await col('companies')).countDocuments({}), 0, 'company rolled back');
  assert.equal(await (await col('company_members')).countDocuments({}), 0, 'no orphan membership');
  assert.equal((await getEmployerUserById(user._id.toString())).companyId, null);
});

test('double failure (member insert + rollback both fail) rethrows the ORIGINAL error', async () => {
  const user = await freshUser();
  const throwingInsertMember = () => { throw new Error('member insert boom'); };
  const throwingCleanup = () => { throw new Error('cleanup boom'); };
  await assert.rejects(
    () => onboardEmployerCompany(
      { employerUserId: user._id.toString(), name: 'Acme' },
      { insertMember: throwingInsertMember, cleanup: throwingCleanup },
    ),
    (err) => err.message === 'member insert boom', // the real reason, not the cleanup error (D2)
  );
});
