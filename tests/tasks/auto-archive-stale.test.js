// FILE: tests/tasks/auto-archive-stale.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { autoArchiveStale, autoArchiveStaleForCompany } from '../../src/tasks/auto-archive-stale.js';

const NOW = new Date('2026-08-11T12:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 86400000);

const COLLECTIONS = ['companies', 'jobs', 'applications', 'interviews', 'archive_reasons', 'stage_changes'];

before(async () => { await dropCollections(...COLLECTIONS); });
beforeEach(async () => { await dropCollections(...COLLECTIONS); });
after(async () => { await closeTestDb(); });

/** A company with one active posting and one closed posting. */
async function seedCompany({ autoArchiveStaleDays = 30 } = {}) {
  const company = { _id: new ObjectId(), name: 'Acme', autoArchiveStaleDays };
  await (await col('companies')).insertOne(company);
  const activePosting = { _id: new ObjectId(), companyId: company._id, source: 'native', status: 'active', title: 'Engineer' };
  const closedPosting = { _id: new ObjectId(), companyId: company._id, source: 'native', status: 'closed', title: 'Designer' };
  await (await col('jobs')).insertMany([activePosting, closedPosting]);
  return { company, activePosting, closedPosting };
}

async function seedApplication(company, posting, { movedDaysAgo, archived = null }) {
  const doc = {
    _id: new ObjectId(), companyId: company._id, jobId: posting._id,
    stageId: new ObjectId(), archived, lastStageMovedAt: daysAgo(movedDaysAgo),
  };
  await (await col('applications')).insertOne(doc);
  return doc;
}

test('archives only quiet candidates on active postings', async () => {
  const { company, activePosting, closedPosting } = await seedCompany();
  const stale = await seedApplication(company, activePosting, { movedDaysAgo: 45 });
  const recent = await seedApplication(company, activePosting, { movedDaysAgo: 3 });
  const onClosed = await seedApplication(company, closedPosting, { movedDaysAgo: 90 });

  const result = await autoArchiveStaleForCompany(company, NOW);
  assert.equal(result.archived, 1);
  assert.equal(result.postings, 1);

  const applications = await col('applications');
  assert.ok((await applications.findOne({ _id: stale._id })).archived);
  assert.equal((await applications.findOne({ _id: recent._id })).archived, null);
  assert.equal((await applications.findOne({ _id: onClosed._id })).archived, null);
});

test('a candidate with a future interview is left alone', async () => {
  const { company, activePosting } = await seedCompany();
  const booked = await seedApplication(company, activePosting, { movedDaysAgo: 60 });
  const past = await seedApplication(company, activePosting, { movedDaysAgo: 60 });
  await (await col('interviews')).insertMany([
    { companyId: company._id, applicationId: booked._id, status: 'scheduled', startAtUtc: daysAgo(-4) },
    { companyId: company._id, applicationId: past._id, status: 'scheduled', startAtUtc: daysAgo(10) },
  ]);

  const result = await autoArchiveStaleForCompany(company, NOW);
  assert.equal(result.archived, 1);
  const applications = await col('applications');
  assert.equal((await applications.findOne({ _id: booked._id })).archived, null);
  assert.ok((await applications.findOne({ _id: past._id })).archived);
});

test('archiving files under a "No response" reason and writes the timeline entry', async () => {
  const { company, activePosting } = await seedCompany();
  const stale = await seedApplication(company, activePosting, { movedDaysAgo: 40 });

  await autoArchiveStaleForCompany(company, NOW);
  const reason = await (await col('archive_reasons')).findOne({ companyId: company._id });
  assert.equal(reason.text, 'No response');

  const archived = await (await col('applications')).findOne({ _id: stale._id });
  assert.equal(archived.archived.reasonId.toString(), reason._id.toString());

  const change = await (await col('stage_changes')).findOne({ applicationId: stale._id });
  assert.equal(change.note, 'Archived: No response');
  assert.equal(change.movedByUserId, null);
});

test('a second run is a no-op — the task is idempotent', async () => {
  const { company, activePosting } = await seedCompany();
  await seedApplication(company, activePosting, { movedDaysAgo: 40 });

  assert.equal((await autoArchiveStaleForCompany(company, NOW)).archived, 1);
  assert.equal((await autoArchiveStaleForCompany(company, NOW)).archived, 0);
  assert.equal(await (await col('stage_changes')).countDocuments({}), 1);
  assert.equal(await (await col('archive_reasons')).countDocuments({}), 1);
});

test('a company that has not opted in is skipped entirely', async () => {
  const { company, activePosting } = await seedCompany({ autoArchiveStaleDays: null });
  await seedApplication(company, activePosting, { movedDaysAgo: 400 });

  assert.equal((await autoArchiveStaleForCompany(company, NOW)).archived, 0);
  // The sweep only selects opted-in companies, so nothing is touched there either.
  assert.deepEqual(await autoArchiveStale(NOW), { archived: 0, postings: 0, companies: 0 });
});

test('the sweep honours each company\'s own threshold', async () => {
  const eager = await seedCompany({ autoArchiveStaleDays: 7 });
  const patient = await seedCompany({ autoArchiveStaleDays: 90 });
  await seedApplication(eager.company, eager.activePosting, { movedDaysAgo: 10 });
  await seedApplication(patient.company, patient.activePosting, { movedDaysAgo: 10 });

  const result = await autoArchiveStale(NOW);
  assert.equal(result.companies, 2);
  assert.equal(result.archived, 1);
});
