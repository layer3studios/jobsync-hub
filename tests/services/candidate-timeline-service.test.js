// FILE: tests/services/candidate-timeline-service.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { createCompany } from '../../src/models/employer/company-model.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { buildCandidateTimeline } from '../../src/services/employer/candidate-timeline-service.js';

const HOUR_MS = 3600000;
const T0 = new Date('2026-07-01T10:00:00.000Z');
const at = (hours) => new Date(T0.getTime() + hours * HOUR_MS);

async function seedFullHistory() {
  const company = await createCompany({ name: 'Acme' }, new ObjectId());
  const companyId = company._id;
  const stages = await seedDefaultStagesForCompany(companyId);
  const stageByText = new Map(stages.map((s) => [s.text, s._id]));

  const { insertedId: actorId } = await (await col('employer_users')).insertOne({ name: 'Grace Founder', email: 'g@x.io' });
  const { insertedId: contactId } = await (await col('contacts')).insertOne({ companyId, fullName: 'Ada', email: 'ada@x.io' });
  const { insertedId: appId } = await (await col('applications')).insertOne({
    companyId, jobId: new ObjectId(), contactId, stageId: stageByText.get('Interview'),
    archived: null, appliedAt: T0, lastStageMovedAt: at(2), createdAt: T0, updatedAt: at(2),
  });

  await (await col('resume_score_jobs')).insertOne({ companyId, applicationId: appId, status: 'done', completedAt: at(1) });
  await (await col('resume_scores')).insertOne({ companyId, applicationId: appId, score: 82 });
  await (await col('stage_changes')).insertOne({
    applicationId: appId, fromStageId: stageByText.get('Applied'), toStageId: stageByText.get('Shortlisted'),
    movedByUserId: actorId, movedAt: at(2), note: null,
  });
  await (await col('interviews')).insertOne({
    companyId, applicationId: appId, postingId: new ObjectId(), contactId,
    status: 'completed', createdAt: at(3), bookedAt: at(4), startAtUtc: at(5),
    durationMinutes: 45, completedAt: at(6), recommendation: 'yes', feedbackText: 'Strong systems knowledge overall.',
  });
  await (await col('applicant_notes')).insertOne({
    companyId, applicationId: appId, authorEmployerUserId: actorId, authorName: 'Grace Founder',
    authorEmail: 'g@x.io', body: 'Follow up next week', createdAt: at(7), updatedAt: at(7),
  });

  return { companyId, appId };
}

beforeEach(async () => {
  await dropCollections(
    'companies', 'stages', 'applications', 'contacts', 'employer_users',
    'interviews', 'applicant_notes', 'stage_changes', 'resume_scores', 'resume_score_jobs',
  );
});
after(async () => { await closeTestDb(); });

test('timeline includes applied, scored, stage_move, interview and note events', async () => {
  const { companyId, appId } = await seedFullHistory();
  const events = await buildCandidateTimeline(companyId, appId);
  const types = events.map((event) => event.type);
  for (const expected of [
    'applied', 'scored', 'stage_move', 'interview_proposed', 'interview_booked',
    'interview_completed', 'note_added',
  ]) {
    assert.ok(types.includes(expected), `missing ${expected}`);
  }
  const scored = events.find((event) => event.type === 'scored');
  assert.equal(scored.score, 82);
  const move = events.find((event) => event.type === 'stage_move');
  assert.equal(move.fromStage, 'Applied');
  assert.equal(move.toStage, 'Shortlisted');
  assert.equal(move.actorName, 'Grace Founder');
  const feedback = events.find((event) => event.type === 'interview_completed');
  assert.equal(feedback.recommendation, 'yes');
});

test('events are sorted newest first', async () => {
  const { companyId, appId } = await seedFullHistory();
  const events = await buildCandidateTimeline(companyId, appId);
  const times = events.map((event) => event.timestamp.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.equal(events[0].type, 'note_added'); // T0+7h is the newest
  assert.equal(events[events.length - 1].type, 'applied');
});

test('cross-tenant: the wrong companyId returns an empty timeline', async () => {
  const { appId } = await seedFullHistory();
  const otherCompany = await createCompany({ name: 'Evil Corp' }, new ObjectId());
  const events = await buildCandidateTimeline(otherCompany._id, appId);
  assert.deepEqual(events, []);
});

test('timeline never contains companyId, contactId or internal ids', async () => {
  const { companyId, appId } = await seedFullHistory();
  const events = await buildCandidateTimeline(companyId, appId);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('companyId'));
  assert.ok(!serialized.includes('contactId'));
  assert.ok(!serialized.includes('applicationId'));
  assert.ok(!serialized.includes(companyId.toString()));
});
