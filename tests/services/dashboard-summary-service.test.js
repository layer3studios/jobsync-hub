// FILE: tests/services/dashboard-summary-service.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { createCompany } from '../../src/models/employer/company-model.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { buildDashboardSummary } from '../../src/services/employer/dashboard-summary-service.js';

const NOW = new Date('2026-07-29T12:00:00.000Z'); // a Wednesday
const DAY_MS = 86400000;

async function seedCompany(tag) {
  const company = await createCompany({ name: `Acme ${tag}` }, new ObjectId());
  const stages = await seedDefaultStagesForCompany(company._id);
  const stageByText = new Map(stages.map((s) => [s.text, s._id]));
  return { companyId: company._id, stageByText };
}

async function seedPosting(companyId, title, { status = 'active', createdAt = NOW } = {}) {
  const doc = {
    companyId, source: 'native', status, title, slug: title.toLowerCase().replace(/\s+/g, '-'),
    location: 'Bengaluru', workplaceType: 'remote', createdAt, updatedAt: createdAt,
  };
  const { insertedId } = await (await col('jobs')).insertOne(doc);
  return insertedId;
}

async function seedContact(companyId, fullName, email) {
  const { insertedId } = await (await col('contacts')).insertOne({ companyId, fullName, email });
  return insertedId;
}

async function seedApplication(companyId, jobId, contactId, stageId, { appliedAt = NOW, lastStageMovedAt = NOW, score = null } = {}) {
  const { insertedId } = await (await col('applications')).insertOne({
    companyId, jobId, contactId, stageId, archived: null,
    appliedAt, lastStageMovedAt, createdAt: appliedAt, updatedAt: lastStageMovedAt,
  });
  if (score !== null) {
    await (await col('resume_scores')).insertOne({ applicationId: insertedId, companyId, score });
  }
  return insertedId;
}

beforeEach(async () => {
  await dropCollections('jobs', 'companies', 'stages', 'applications', 'contacts', 'resume_scores', 'interviews', 'interview_times');
});
after(async () => { await closeTestDb(); });

test('summary returns all five KPIs with correct types and values', async () => {
  const { companyId, stageByText } = await seedCompany('a');
  const jobId = await seedPosting(companyId, 'React Dev', { createdAt: new Date(NOW.getTime() - 3 * DAY_MS) });
  await seedPosting(companyId, 'Closed Role', { status: 'closed' });
  const c1 = await seedContact(companyId, 'Ada', 'ada@x.io');
  const c2 = await seedContact(companyId, 'Bea', 'bea@x.io');
  await seedApplication(companyId, jobId, c1, stageByText.get('Applied'), { score: 80 });
  await seedApplication(companyId, jobId, c2, stageByText.get('Shortlisted'), { score: 60 });

  const summary = await buildDashboardSummary(companyId, { now: NOW });
  assert.equal(summary.kpis.activeJobs, 1);
  assert.equal(summary.kpis.totalApplicants, 2);
  assert.equal(typeof summary.kpis.interviewsThisWeek, 'number');
  assert.equal(summary.kpis.avgAiScore, 70);
  assert.equal(summary.kpis.avgDaysToHire, null);
  assert.equal(summary.kpis.strongMatches, 1); // only the score-80 applicant
  assert.equal(summary.kpis.newThisWeek, 2);   // both applied at NOW (a Wednesday)
  assert.equal(summary.activeJobs.length, 1);
  assert.equal(summary.activeJobs[0].applicantCount, 2);
  assert.equal(summary.activeJobs[0].daysOpen, 3);
  assert.equal(summary.activeJobs[0].stageCounts.applied, 1);
  assert.equal(summary.activeJobs[0].stageCounts.shortlisted, 1);
});

test('topCandidates sorted by score desc, limited to 5, no internal fields', async () => {
  const { companyId, stageByText } = await seedCompany('b');
  const jobId = await seedPosting(companyId, 'React Dev');
  for (let i = 0; i < 6; i += 1) {
    const contactId = await seedContact(companyId, `C${i}`, `c${i}@x.io`);
    await seedApplication(companyId, jobId, contactId, stageByText.get('Applied'), { score: 50 + i * 5 });
  }
  const { topCandidates } = await buildDashboardSummary(companyId, { now: NOW });
  assert.equal(topCandidates.length, 5);
  const scores = topCandidates.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(scores[0], 75);
  for (const candidate of topCandidates) {
    assert.ok(!('companyId' in candidate));
    assert.ok(!('contactId' in candidate));
    assert.ok(!('resumeUrl' in candidate));
    assert.equal(typeof candidate.contactName, 'string');
  }
});

test('avgAiScore is null when no applicants have scores', async () => {
  const { companyId, stageByText } = await seedCompany('c');
  const jobId = await seedPosting(companyId, 'React Dev');
  const contactId = await seedContact(companyId, 'Ada', 'ada@x.io');
  await seedApplication(companyId, jobId, contactId, stageByText.get('Applied'));
  const { kpis } = await buildDashboardSummary(companyId, { now: NOW });
  assert.equal(kpis.avgAiScore, null);
});

test('avgDaysToHire averages appliedAt→hire; null when nobody hired', async () => {
  const { companyId, stageByText } = await seedCompany('d');
  const jobId = await seedPosting(companyId, 'React Dev');
  const contactId = await seedContact(companyId, 'Ada', 'ada@x.io');
  await seedApplication(companyId, jobId, contactId, stageByText.get('Hired'), {
    appliedAt: new Date(NOW.getTime() - 10 * DAY_MS), lastStageMovedAt: NOW,
  });
  const { kpis } = await buildDashboardSummary(companyId, { now: NOW });
  assert.equal(kpis.avgDaysToHire, 10);
});

test('interviewsThisWeek counts only this week\'s scheduled interviews', async () => {
  const { companyId } = await seedCompany('e');
  const interviews = await col('interviews');
  const base = { companyId, applicationId: new ObjectId(), postingId: new ObjectId(), contactId: new ObjectId() };
  await interviews.insertMany([
    { ...base, status: 'scheduled', startAtUtc: NOW },                                      // counts
    { ...base, status: 'scheduled', startAtUtc: new Date(NOW.getTime() + 7 * DAY_MS) },     // next week
    { ...base, status: 'cancelled', startAtUtc: NOW },                                      // wrong status
  ]);
  const { kpis } = await buildDashboardSummary(companyId, { now: NOW });
  assert.equal(kpis.interviewsThisWeek, 1);
});

test('newThisWeek counts only this week\'s applications', async () => {
  const { companyId, stageByText } = await seedCompany('h');
  const jobId = await seedPosting(companyId, 'React Dev');
  const contactId = await seedContact(companyId, 'Ada', 'ada@x.io');
  await seedApplication(companyId, jobId, contactId, stageByText.get('Applied'), { appliedAt: NOW });
  const c2 = await seedContact(companyId, 'Old', 'old@x.io');
  await seedApplication(companyId, jobId, c2, stageByText.get('Applied'), {
    appliedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  const { kpis } = await buildDashboardSummary(companyId, { now: NOW });
  assert.equal(kpis.newThisWeek, 1);
  assert.equal(kpis.totalApplicants, 2);
});

test('a throwing stale detector never fails the summary; other items survive', async () => {
  const { companyId } = await seedCompany('i');
  await (await col('interviews')).insertOne({
    companyId, applicationId: new ObjectId(), postingId: new ObjectId(), contactId: new ObjectId(),
    status: 'scheduled', startAtUtc: new Date(NOW.getTime() + 3600000),
  });
  const summary = await buildDashboardSummary(companyId, {
    now: NOW,
    attentionDeps: { loadStale: () => { throw new Error('stale detection broke'); } },
  });
  assert.ok(summary.kpis); // the summary itself survived
  assert.equal(summary.needsAttention.filter((i) => i.type === 'stale').length, 0);
  assert.equal(summary.needsAttention.filter((i) => i.type === 'upcoming_interview').length, 1);
});

test('cross-tenant: another company\'s data never appears', async () => {
  const a = await seedCompany('f');
  const b = await seedCompany('g');
  const jobB = await seedPosting(b.companyId, 'Their Job');
  const contactB = await seedContact(b.companyId, 'Mallory', 'mal@evil.io');
  await seedApplication(b.companyId, jobB, contactB, b.stageByText.get('Applied'), { score: 99 });

  const summary = await buildDashboardSummary(a.companyId, { now: NOW });
  assert.equal(summary.kpis.activeJobs, 0);
  assert.equal(summary.kpis.totalApplicants, 0);
  assert.deepEqual(summary.activeJobs, []);
  assert.deepEqual(summary.topCandidates, []);
});
