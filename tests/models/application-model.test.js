import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureApplicationIndexes, createApplicationForCompany, getApplicationForCompany,
  listApplicationsForJob, countApplicationsForJob,
} from '../../src/models/public/application-model.js';

const COMPANY_A = new ObjectId();
const COMPANY_B = new ObjectId();
const JOB_1 = new ObjectId();
const JOB_2 = new ObjectId();

function base(jobId) {
  return { jobId, contactId: new ObjectId(), stageId: new ObjectId(), resumeFileId: new ObjectId(), consent: { dpdpAcceptedAt: new Date() } };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('applications');
  await ensureApplicationIndexes();
}

test('create + get scoped by companyId', async () => {
  const app = await createApplicationForCompany(COMPANY_A, base(JOB_1));
  const got = await getApplicationForCompany(COMPANY_A, app._id);
  assert.equal(got._id.toString(), app._id.toString());
  assert.equal(got.archived, null);
  assert.ok(got.appliedAt instanceof Date);
});

test('listApplicationsForJob returns only that job\'s applications', async () => {
  await createApplicationForCompany(COMPANY_A, base(JOB_1));
  await createApplicationForCompany(COMPANY_A, base(JOB_1));
  await createApplicationForCompany(COMPANY_A, base(JOB_2));
  const job1 = await listApplicationsForJob(COMPANY_A, JOB_1);
  assert.equal(job1.length, 2);
});

test('countApplicationsForJob is correct', async () => {
  await createApplicationForCompany(COMPANY_A, base(JOB_1));
  await createApplicationForCompany(COMPANY_A, base(JOB_1));
  assert.equal(await countApplicationsForJob(COMPANY_A, JOB_1), 2);
});

test('cross-tenant: another company cannot read the application', async () => {
  const app = await createApplicationForCompany(COMPANY_A, base(JOB_1));
  assert.equal(await getApplicationForCompany(COMPANY_B, app._id), null);
  assert.deepEqual(await listApplicationsForJob(COMPANY_B, JOB_1), []);
});
