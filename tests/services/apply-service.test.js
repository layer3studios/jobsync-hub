import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { ensureContactIndexes } from '../../src/models/public/contact-model.js';
import { processApplication } from '../../src/services/public/apply-service.js';

const COMPANY_ID = new ObjectId();
const JOB_ID = new ObjectId();
const STAGE_ID = new ObjectId();

let stored = [];
let deleted = [];
const storage = {
  storeResumeFile: () => { stored.push(1); return { storagePath: 'data/resumes/x.pdf', sizeBytes: 100 }; },
  deleteResumeFile: (p) => deleted.push(p),
};
const resume = { buffer: Buffer.from('%PDF'), originalFilename: 'cv.pdf', mimeType: 'application/pdf' };
const validForm = { firstName: 'Asha', lastName: 'Rao', email: 'asha@x.com', consent_dpdp: true };

async function apply(form = validForm, slug = 'acme', jobSlug = 'react-dev') {
  return processApplication(slug, jobSlug, form, resume, { applicantIp: '1.2.3.4' }, storage);
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('companies', 'jobs', 'stages', 'contacts', 'applications', 'stage_changes', 'resume_files');
  await ensureContactIndexes();
  stored = []; deleted = [];
  await (await col('companies')).insertOne({ _id: COMPANY_ID, slug: 'acme', name: 'Acme' });
  await (await col('jobs')).insertOne({ _id: JOB_ID, companyId: COMPANY_ID, slug: 'react-dev', source: 'native', status: 'active', title: 'React Dev' });
  await (await col('stages')).insertOne({ _id: STAGE_ID, companyId: COMPANY_ID, isDefault: true, text: 'Applied', order: 1 });
}

async function expectError(fn, status, code) {
  await assert.rejects(fn, (err) => { assert.equal(err.status, status); assert.equal(err.code, code); return true; });
}

test('happy path creates contact, resume file, application, stage change', async () => {
  const { applicationId } = await apply();
  assert.ok(applicationId && applicationId !== 'ok');
  assert.equal(await (await col('contacts')).countDocuments({ companyId: COMPANY_ID }), 1);
  assert.equal(await (await col('resume_files')).countDocuments({}), 1);
  assert.equal(await (await col('applications')).countDocuments({ companyId: COMPANY_ID }), 1);
  const change = await (await col('stage_changes')).findOne({});
  assert.equal(change.fromStageId, null);
  assert.equal(change.toStageId.toString(), STAGE_ID.toString());
});

test('same email twice → one contact, two applications', async () => {
  await apply();
  await apply();
  assert.equal(await (await col('contacts')).countDocuments({ companyId: COMPANY_ID }), 1);
  assert.equal(await (await col('applications')).countDocuments({ companyId: COMPANY_ID }), 2);
});

test('honeypot filled → returns ok, stores nothing', async () => {
  const result = await apply({ ...validForm, website_url: 'http://spam.example' });
  assert.equal(result.applicationId, 'ok');
  assert.equal(await (await col('applications')).countDocuments({}), 0);
  assert.equal(stored.length, 0);
});

test('missing first name → 400 INVALID_FIRST_NAME', async () => {
  await expectError(() => apply({ ...validForm, firstName: '' }), 400, 'INVALID_FIRST_NAME');
});

test('invalid email → 400 INVALID_EMAIL', async () => {
  await expectError(() => apply({ ...validForm, email: 'not-an-email' }), 400, 'INVALID_EMAIL');
});

test('missing consent → 400 CONSENT_REQUIRED', async () => {
  await expectError(() => apply({ ...validForm, consent_dpdp: false }), 400, 'CONSENT_REQUIRED');
});

test('unknown company → 404 COMPANY_NOT_FOUND', async () => {
  await expectError(() => apply(validForm, 'nope'), 404, 'COMPANY_NOT_FOUND');
});

test('closed/unknown posting → 404 POSTING_NOT_FOUND', async () => {
  await (await col('jobs')).updateOne({ _id: JOB_ID }, { $set: { status: 'closed' } });
  await expectError(() => apply(), 404, 'POSTING_NOT_FOUND');
});
