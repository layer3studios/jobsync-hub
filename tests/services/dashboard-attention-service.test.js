// FILE: tests/services/dashboard-attention-service.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { createCompany } from '../../src/models/employer/company-model.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { buildNeedsAttention } from '../../src/services/employer/dashboard-attention-service.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

async function seedCompany(tag) {
  const company = await createCompany({ name: `Acme ${tag}` }, new ObjectId());
  const stages = await seedDefaultStagesForCompany(company._id);
  return { companyId: company._id, stageByText: new Map(stages.map((s) => [s.text, s._id])) };
}

async function seedPosting(companyId, title) {
  const { insertedId } = await (await col('jobs')).insertOne({
    companyId, source: 'native', status: 'active', title, slug: title.toLowerCase().replace(/\s+/g, '-'),
    location: 'Remote', workplaceType: 'remote', createdAt: NOW, updatedAt: NOW,
  });
  return { _id: insertedId, title };
}

async function seedApplication(companyId, jobId, stageId, lastStageMovedAt, name = 'Ada') {
  const { insertedId: contactId } = await (await col('contacts')).insertOne({ companyId, fullName: name, email: `${name}@x.io` });
  const { insertedId } = await (await col('applications')).insertOne({
    companyId, jobId, contactId, stageId, archived: null,
    appliedAt: lastStageMovedAt, lastStageMovedAt, createdAt: lastStageMovedAt, updatedAt: lastStageMovedAt,
  });
  return insertedId;
}

beforeEach(async () => {
  await dropCollections('jobs', 'companies', 'stages', 'applications', 'contacts', 'interviews', 'interview_times');
});
after(async () => { await closeTestDb(); });

test('unreviewed: >48h in Applied included, moved within 48h excluded', async () => {
  const { companyId, stageByText } = await seedCompany('a');
  const posting = await seedPosting(companyId, 'React Dev');
  await seedApplication(companyId, posting._id, stageByText.get('Applied'), new Date(NOW.getTime() - 60 * HOUR_MS), 'Old');
  await seedApplication(companyId, posting._id, stageByText.get('Applied'), new Date(NOW.getTime() - 10 * HOUR_MS), 'Fresh');

  const items = await buildNeedsAttention(companyId, { now: NOW, postings: [posting] });
  const unreviewed = items.filter((item) => item.type === 'unreviewed');
  assert.equal(unreviewed.length, 1);
  assert.equal(unreviewed[0].count, 1); // only the 60h-old application
  assert.equal(unreviewed[0].postingTitle, 'React Dev');
});

test('stale: non-terminal stage > 14 days included; Applied and Hired excluded', async () => {
  const { companyId, stageByText } = await seedCompany('b');
  const posting = await seedPosting(companyId, 'React Dev');
  const old = new Date(NOW.getTime() - 20 * DAY_MS);
  await seedApplication(companyId, posting._id, stageByText.get('Shortlisted'), old, 'Stuck');
  await seedApplication(companyId, posting._id, stageByText.get('Applied'), old, 'Unreviewed');
  await seedApplication(companyId, posting._id, stageByText.get('Hired'), old, 'Done');

  const items = await buildNeedsAttention(companyId, { now: NOW, postings: [posting] });
  const stale = items.filter((item) => item.type === 'stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].contactName, 'Stuck');
  assert.equal(stale[0].stage, 'Shortlisted');
  assert.equal(stale[0].daysInStage, 20);
});

test('upcoming interviews (next 48h) appear and sort first', async () => {
  const { companyId, stageByText } = await seedCompany('c');
  const posting = await seedPosting(companyId, 'React Dev');
  await seedApplication(companyId, posting._id, stageByText.get('Applied'), new Date(NOW.getTime() - 60 * HOUR_MS));
  const { insertedId: contactId } = await (await col('contacts')).insertOne({ companyId, fullName: 'Cand', email: 'cand@x.io' });
  await (await col('interviews')).insertMany([
    { companyId, applicationId: new ObjectId(), postingId: posting._id, contactId,
      status: 'scheduled', startAtUtc: new Date(NOW.getTime() + 5 * HOUR_MS), meetingUrl: 'https://meet.x/1' },
    { companyId, applicationId: new ObjectId(), postingId: posting._id, contactId,
      status: 'scheduled', startAtUtc: new Date(NOW.getTime() + 90 * HOUR_MS) }, // outside window
  ]);

  const items = await buildNeedsAttention(companyId, { now: NOW, postings: [posting] });
  const upcoming = items.filter((item) => item.type === 'upcoming_interview');
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].candidateName, 'Cand');
  assert.equal(upcoming[0].meetingUrl, 'https://meet.x/1');
  assert.equal(items[0].type, 'upcoming_interview'); // sorted before unreviewed
  assert.ok(items.some((item) => item.type === 'unreviewed'));
});

test('pool_low: appears when a pool exists with <=1 available future time', async () => {
  const { companyId } = await seedCompany('d');
  const posting = await seedPosting(companyId, 'React Dev');
  const noPool = await seedPosting(companyId, 'No Pool Role');
  await (await col('interview_times')).insertMany([
    { companyId, postingId: posting._id, status: 'available', startAtUtc: new Date(NOW.getTime() + DAY_MS) },
    { companyId, postingId: posting._id, status: 'booked', startAtUtc: new Date(NOW.getTime() + 2 * DAY_MS) },
  ]);

  const items = await buildNeedsAttention(companyId, { now: NOW, postings: [posting, noPool] });
  const poolLow = items.filter((item) => item.type === 'pool_low');
  assert.equal(poolLow.length, 1); // no-pool posting stays quiet
  assert.equal(poolLow[0].postingTitle, 'React Dev');
  assert.equal(poolLow[0].availableCount, 1);
});

test('a throwing detector is skipped; the others still return', async () => {
  const { companyId, stageByText } = await seedCompany('e');
  const posting = await seedPosting(companyId, 'React Dev');
  await seedApplication(companyId, posting._id, stageByText.get('Applied'), new Date(NOW.getTime() - 60 * HOUR_MS));

  const items = await buildNeedsAttention(companyId, {
    now: NOW, postings: [posting],
    deps: { loadStale: () => { throw new Error('boom'); } },
  });
  assert.equal(items.filter((item) => item.type === 'stale').length, 0);
  assert.equal(items.filter((item) => item.type === 'unreviewed').length, 1);
});
