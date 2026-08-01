// FILE: tests/services/rejection-email-service.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { createCompany } from '../../src/models/employer/company-model.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { sendRejectionEmail, sendPositionFilledEmails } from '../../src/services/email/rejection-email-service.js';

const noAudit = { appendAuditEntry: async () => {} };

async function seedCompany(tag) {
  const company = await createCompany({ name: `Acme ${tag}` }, new ObjectId());
  const stages = await seedDefaultStagesForCompany(company._id);
  return { companyId: company._id, stageByText: new Map(stages.map((s) => [s.text, s._id])) };
}

async function seedPosting(companyId, title = 'React Dev') {
  const { insertedId } = await (await col('jobs')).insertOne({
    companyId, source: 'native', status: 'active', title, slug: title.toLowerCase().replace(/\s+/g, '-'),
    createdAt: new Date(), updatedAt: new Date(),
  });
  return insertedId;
}

async function seedApplicant(companyId, jobId, stageId, { name = 'Ada', email = 'ada@x.io' } = {}) {
  const { insertedId: contactId } = await (await col('contacts')).insertOne({ companyId, fullName: name, email });
  const now = new Date();
  const { insertedId } = await (await col('applications')).insertOne({
    companyId, jobId, contactId, stageId, archived: null,
    appliedAt: now, lastStageMovedAt: now, createdAt: now, updatedAt: now,
  });
  return insertedId;
}

/** Capture sends instead of hitting the (disabled) email client. */
function captureEmails(sentBox, { failFirst = false } = {}) {
  let callCount = 0;
  return async (payload) => {
    callCount += 1;
    if (failFirst && callCount === 1) throw new Error('smtp down');
    sentBox.push(payload);
    return { sent: true, code: null, emailId: 'e1' };
  };
}

beforeEach(async () => {
  await dropCollections('companies', 'stages', 'jobs', 'contacts', 'applications', 'audit_log');
});
after(async () => { await closeTestDb(); });

test('archive at Applied stage sends the brief application template', async () => {
  const { companyId, stageByText } = await seedCompany('a');
  const jobId = await seedPosting(companyId);
  const appId = await seedApplicant(companyId, jobId, stageByText.get('Applied'));
  const sent = [];
  const result = await sendRejectionEmail(companyId, appId, { reason: 'Not a fit' },
    { sendEmail: captureEmails(sent), ...noAudit });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ada@x.io');
  assert.equal(sent[0].subject, 'Update on your application for React Dev');
  assert.ok(sent[0].text.includes('Ada'));
  assert.ok(sent[0].text.includes('Acme a'));
});

test('archive at Interview stage sends the post-interview template', async () => {
  const { companyId, stageByText } = await seedCompany('b');
  const jobId = await seedPosting(companyId);
  const appId = await seedApplicant(companyId, jobId, stageByText.get('Interview'));
  const sent = [];
  await sendRejectionEmail(companyId, appId, {}, { sendEmail: captureEmails(sent), ...noAudit });
  assert.equal(sent[0].subject, 'Following up on your interview for React Dev');
});

test('skipEmail true sends nothing', async () => {
  const { companyId, stageByText } = await seedCompany('c');
  const jobId = await seedPosting(companyId);
  const appId = await seedApplicant(companyId, jobId, stageByText.get('Applied'));
  const sent = [];
  const result = await sendRejectionEmail(companyId, appId, { skipEmail: true },
    { sendEmail: captureEmails(sent), ...noAudit });
  assert.deepEqual(result, { sent: false, skipped: true });
  assert.equal(sent.length, 0);
});

test('position filled emails every non-terminal applicant except exclusions', async () => {
  const { companyId, stageByText } = await seedCompany('d');
  const jobId = await seedPosting(companyId);
  await seedApplicant(companyId, jobId, stageByText.get('Applied'), { name: 'A', email: 'a@x.io' });
  await seedApplicant(companyId, jobId, stageByText.get('Shortlisted'), { name: 'B', email: 'b@x.io' });
  const hiredAppId = await seedApplicant(companyId, jobId, stageByText.get('Interview'), { name: 'Winner', email: 'w@x.io' });
  await seedApplicant(companyId, jobId, stageByText.get('Hired'), { name: 'Terminal', email: 't@x.io' });

  const sent = [];
  const result = await sendPositionFilledEmails(companyId, jobId,
    { excludeApplicationIds: [hiredAppId.toString()] }, { sendEmail: captureEmails(sent) });
  assert.equal(result.sent, 2); // A + B; Winner excluded, Terminal is at a terminal stage
  assert.equal(result.failed, 0);
  const recipients = sent.map((e) => e.to).sort();
  assert.deepEqual(recipients, ['a@x.io', 'b@x.io']);
  assert.equal(sent[0].subject, 'Update on the React Dev position');
});

test('one email failure does not block the others', async () => {
  const { companyId, stageByText } = await seedCompany('e');
  const jobId = await seedPosting(companyId);
  await seedApplicant(companyId, jobId, stageByText.get('Applied'), { name: 'A', email: 'a@x.io' });
  await seedApplicant(companyId, jobId, stageByText.get('Applied'), { name: 'B', email: 'b@x.io' });
  await seedApplicant(companyId, jobId, stageByText.get('Applied'), { name: 'C', email: 'c@x.io' });

  const sent = [];
  const result = await sendPositionFilledEmails(companyId, jobId, {},
    { sendEmail: captureEmails(sent, { failFirst: true }) });
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1); // the thrown send is counted, not lost
  assert.equal(sent.length, 2);
});
