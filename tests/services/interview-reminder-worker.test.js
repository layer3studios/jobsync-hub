import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  processReminderJob, processDueReminderJobs,
} from '../../src/services/interview/interview-reminder-worker.js';
import {
  ensureInterviewReminderJobIndexes, scheduleInterviewReminders, claimDueReminderJob,
  REMINDER_JOB_STATUS,
} from '../../src/models/interview/interview-reminder-job-model.js';
import {
  ensureInterviewIndexes, createInterviewForCompany, interviewsCol, bookInterviewSlot,
} from '../../src/models/interview/index.js';
import { sendInterviewConfirmationEmails } from '../../src/services/interview/interview-notification-service.js';

const COMPANY_A = new ObjectId();
const CREATOR = new ObjectId();
const HOURS = (n) => n * 60 * 60 * 1000;
const jobs = async () => (await col('interview_reminder_jobs'));

let postingId; let contactId;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interview_reminder_jobs', 'interviews', 'companies', 'jobs', 'contacts', 'employer_users');
  await ensureInterviewReminderJobIndexes();
  await ensureInterviewIndexes();
  postingId = new ObjectId(); contactId = new ObjectId();
  await (await col('companies')).insertOne({ _id: COMPANY_A, name: 'Acme' });
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: COMPANY_A, title: 'Backend Engineer' });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: COMPANY_A, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('employer_users')).insertOne({ _id: CREATOR, email: 'ravi@acme.in', name: 'Ravi' });
}

async function bookedInterview() {
  const interview = await createInterviewForCompany(COMPANY_A, {
    applicationId: new ObjectId(), postingId, contactId,
    proposedSlots: [
      { startAtUtc: new Date(Date.now() + HOURS(48)), durationMinutes: 45 },
      { startAtUtc: new Date(Date.now() + HOURS(72)), durationMinutes: 45 },
    ],
    durationMinutes: 45, mode: 'video', meetingUrl: 'https://meet.acme.in/x',
    interviewerEmployerUserIds: [],
  }, CREATOR);
  const result = await bookInterviewSlot(interview.bookingToken, 0);
  return result.interview;
}

async function claimJobFor(interview) {
  await scheduleInterviewReminders(interview);
  // Only the candidate job stays in play, so retry loops always reclaim it.
  await (await jobs()).updateOne({ interviewId: interview._id, recipientKind: 'interviewer' }, { $set: { status: REMINDER_JOB_STATUS.CANCELLED } });
  await (await jobs()).updateMany({ interviewId: interview._id }, { $set: { sendAtUtc: new Date(Date.now() - 1000) } });
  return claimDueReminderJob(new Date());
}

test('worker skips and cancels a job whose interview is no longer scheduled', async () => {
  const interview = await bookedInterview();
  const job = await claimJobFor(interview);
  await (await interviewsCol()).updateOne({ _id: interview._id }, { $set: { status: 'cancelled' } });
  const outcome = await processReminderJob(job, { sendEmail: async () => { throw new Error('must not send'); } });
  assert.equal(outcome.outcome, 'cancelled');
  const row = await (await jobs()).findOne({ _id: job._id });
  assert.equal(row.status, REMINDER_JOB_STATUS.CANCELLED);
});

test('the reminder .ics carries the SAME calendarSequence as the confirmation', async () => {
  const interview = await bookedInterview(); // booking incremented sequence to 1
  const decode = (message) => Buffer.from(message.attachments[0].content, 'base64').toString('utf8');

  const confirmations = [];
  await sendInterviewConfirmationEmails(
    { interview, companyName: 'Acme', postingTitle: 'BE', candidateName: 'Asha', candidateEmail: 'asha@example.com', organizerName: 'Ravi', organizerEmail: 'ravi@acme.in', interviewerEmails: [] },
    { sendEmail: async (message) => { confirmations.push(message); return { sent: true, code: null, emailId: 'e' }; } },
  );
  assert.ok(decode(confirmations[0]).includes('SEQUENCE:1'));

  const job = await claimJobFor(interview);
  const reminders = [];
  const outcome = await processReminderJob(job, {
    sendEmail: async (message) => { reminders.push(message); return { sent: true, code: null, emailId: 'e' }; },
  });
  assert.equal(outcome.outcome, 'completed');
  const reminderIcs = decode(reminders[0]);
  assert.ok(reminderIcs.includes('SEQUENCE:1'), 'sequence must NOT be incremented for a reminder');
  assert.ok(reminderIcs.includes('METHOD:REQUEST'));
  assert.ok(reminderIcs.includes(`UID:${interview.calendarUid}`));
});

test('processDueReminderJobs drains every due job', async () => {
  const interview = await bookedInterview();
  await scheduleInterviewReminders(interview);
  await (await jobs()).updateMany({}, { $set: { sendAtUtc: new Date(Date.now() - 1000) } });
  const processed = await processDueReminderJobs(new Date(), {
    sendEmail: async () => ({ sent: true, code: null, emailId: 'e' }),
  });
  assert.equal(processed, 2);
  const remaining = await (await jobs()).countDocuments({ status: REMINDER_JOB_STATUS.PENDING });
  assert.equal(remaining, 0);
});

test('a failed send requeues with backoff, then terminal-fails after max attempts', async () => {
  const interview = await bookedInterview();
  const failingDeps = { sendEmail: async () => ({ sent: false, code: 'SEND_FAILED', emailId: null }) };
  let job = await claimJobFor(interview);
  await processReminderJob(job, failingDeps);
  let row = await (await jobs()).findOne({ _id: job._id });
  assert.equal(row.status, REMINDER_JOB_STATUS.PENDING, 'attempt 1 requeues');

  for (let attempt = 2; attempt <= 3; attempt += 1) {
    await (await jobs()).updateOne({ _id: job._id }, { $set: { sendAtUtc: new Date(Date.now() - 1000) } });
    const claimed = await claimDueReminderJob(new Date());
    await processReminderJob(claimed, failingDeps);
  }
  row = await (await jobs()).findOne({ _id: job._id });
  assert.equal(row.status, REMINDER_JOB_STATUS.FAILED, 'attempt 3 is terminal');
});
