// FILE: tests/services/interview-feedback-service.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { createCompany } from '../../src/models/employer/company-model.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { submitInterviewFeedback, handleNoShow } from '../../src/services/interview/interview-feedback-service.js';

const HOUR_MS = 3600000;
const noAudit = { appendAuditEntry: async () => {} };

async function seedCompany(tag) {
  const company = await createCompany({ name: `Acme ${tag}` }, new ObjectId());
  const stages = await seedDefaultStagesForCompany(company._id);
  return { companyId: company._id, stageByText: new Map(stages.map((s) => [s.text, s._id])) };
}

async function seedApplication(companyId, stageId) {
  const now = new Date();
  const { insertedId } = await (await col('applications')).insertOne({
    companyId, jobId: new ObjectId(), contactId: new ObjectId(), stageId, archived: null,
    appliedAt: now, lastStageMovedAt: now, createdAt: now, updatedAt: now,
  });
  return insertedId;
}

async function seedInterview(companyId, applicationId, { startOffsetHours = -2, status = 'scheduled' } = {}) {
  const { insertedId } = await (await col('interviews')).insertOne({
    companyId, applicationId, postingId: new ObjectId(), contactId: new ObjectId(),
    status, startAtUtc: new Date(Date.now() + startOffsetHours * HOUR_MS),
    durationMinutes: 45, createdAt: new Date(), updatedAt: new Date(),
  });
  return insertedId;
}

const FEEDBACK = { recommendation: 'yes', feedbackText: 'Great communication and solid fundamentals.' };

beforeEach(async () => {
  await dropCollections('companies', 'stages', 'applications', 'interviews', 'interview_times', 'audit_log');
});
after(async () => { await closeTestDb(); });

test('a future interview cannot be completed — INTERVIEW_NOT_YET', async () => {
  const { companyId, stageByText } = await seedCompany('a');
  const appId = await seedApplication(companyId, stageByText.get('Applied'));
  const interviewId = await seedInterview(companyId, appId, { startOffsetHours: 3 });
  const result = await submitInterviewFeedback(companyId, interviewId, FEEDBACK, noAudit);
  assert.equal(result.error, 'INTERVIEW_NOT_YET');
});

test("past + 'yes' → nextAction 'advance' with the NEXT stage suggested", async () => {
  const { companyId, stageByText } = await seedCompany('b');
  const appId = await seedApplication(companyId, stageByText.get('Applied'));
  const interviewId = await seedInterview(companyId, appId);
  const result = await submitInterviewFeedback(companyId, interviewId, FEEDBACK, noAudit);
  assert.equal(result.nextAction, 'advance');
  assert.equal(result.suggestedStage, stageByText.get('Shortlisted').toString());
  assert.equal(result.interview.status, 'completed');
  assert.equal(result.interview.recommendation, 'yes');
});

test('last non-terminal stage suggests the terminal Hired stage', async () => {
  const { companyId, stageByText } = await seedCompany('c');
  const appId = await seedApplication(companyId, stageByText.get('Offer'));
  const interviewId = await seedInterview(companyId, appId);
  const result = await submitInterviewFeedback(companyId, interviewId, FEEDBACK, noAudit);
  assert.equal(result.suggestedStage, stageByText.get('Hired').toString());
});

test("'strong_no' → nextAction 'archive' with a suggested reason", async () => {
  const { companyId, stageByText } = await seedCompany('d');
  const appId = await seedApplication(companyId, stageByText.get('Interview'));
  const interviewId = await seedInterview(companyId, appId);
  const result = await submitInterviewFeedback(companyId, interviewId, {
    recommendation: 'strong_no', feedbackText: 'Not the depth we need for this role.',
  }, noAudit);
  assert.equal(result.nextAction, 'archive');
  assert.equal(result.suggestedReason, 'Not a fit after interview');
});

test('feedbackText under 10 chars is rejected', async () => {
  const { companyId, stageByText } = await seedCompany('e');
  const appId = await seedApplication(companyId, stageByText.get('Applied'));
  const interviewId = await seedInterview(companyId, appId);
  const result = await submitInterviewFeedback(companyId, interviewId, {
    recommendation: 'yes', feedbackText: 'too short',
  }, noAudit);
  assert.equal(result.error, 'FEEDBACK_TOO_SHORT');
});

test('no-show recycles the booked pool time back to available', async () => {
  const { companyId, stageByText } = await seedCompany('f');
  const appId = await seedApplication(companyId, stageByText.get('Interview'));
  const interviewId = await seedInterview(companyId, appId);
  await (await col('interview_times')).insertOne({
    companyId, postingId: new ObjectId(), status: 'booked',
    bookedByInterviewId: interviewId, bookedByApplicationId: appId,
    startAtUtc: new Date(Date.now() - HOUR_MS), bookedAt: new Date(),
  });

  const result = await handleNoShow(companyId, interviewId, { note: 'no reply' }, noAudit);
  assert.equal(result.nextAction, 'flag');
  assert.equal(result.interview.status, 'no_show');
  const time = await (await col('interview_times')).findOne({ companyId });
  assert.equal(time.status, 'available');
  assert.equal(time.bookedByInterviewId, null);
});

test('no-show on a manual interview (no pool time) succeeds without error', async () => {
  const { companyId, stageByText } = await seedCompany('g');
  const appId = await seedApplication(companyId, stageByText.get('Interview'));
  const interviewId = await seedInterview(companyId, appId);
  const result = await handleNoShow(companyId, interviewId, {}, noAudit);
  assert.equal(result.interview.status, 'no_show');
  assert.equal(result.interview.noShowNote, null);
});
