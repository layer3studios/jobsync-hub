import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureInterviewReminderJobIndexes, scheduleInterviewReminders, cancelInterviewReminders,
  claimDueReminderJob, completeReminderJob, requeueReminderJobWithBackoff, failReminderJob,
  REMINDER_JOB_STATUS,
} from '../../src/models/interview/interview-reminder-job-model.js';

const HOURS = (n) => n * 60 * 60 * 1000;
const jobs = async () => (await col('interview_reminder_jobs'));

function interviewDoc(overrides = {}) {
  return {
    _id: new ObjectId(),
    companyId: new ObjectId(),
    startAtUtc: new Date(Date.now() + HOURS(48)),
    ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interview_reminder_jobs');
  await ensureInterviewReminderJobIndexes();
}

test('schedules one candidate + one interviewer job at startAtUtc − 24h', async () => {
  const interview = interviewDoc();
  const result = await scheduleInterviewReminders(interview);
  assert.equal(result.scheduled, true);
  const rows = await (await jobs()).find({ interviewId: interview._id }).toArray();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.recipientKind).sort(), ['candidate', 'interviewer']);
  const expected = interview.startAtUtc.getTime() - HOURS(24);
  for (const row of rows) {
    assert.equal(row.sendAtUtc.getTime(), expected);
    assert.equal(row.status, REMINDER_JOB_STATUS.PENDING);
  }
});

test('UNIQUE INDEX: scheduling twice produces ONE job per recipient, not two', async () => {
  const interview = interviewDoc();
  await scheduleInterviewReminders(interview);
  await scheduleInterviewReminders(interview);
  const count = await (await jobs()).countDocuments({ interviewId: interview._id });
  assert.equal(count, 2, 'exactly one candidate + one interviewer job');
});

test('a booking made 3 hours before the start schedules NO reminder', async () => {
  const interview = interviewDoc({ startAtUtc: new Date(Date.now() + HOURS(3)) });
  const result = await scheduleInterviewReminders(interview);
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, 'INSIDE_LEAD_WINDOW');
  assert.equal(await (await jobs()).countDocuments({}), 0);
});

test('rescheduling moves the existing job rather than creating a second', async () => {
  const interview = interviewDoc();
  await scheduleInterviewReminders(interview);
  const movedStart = new Date(Date.now() + HOURS(96));
  await scheduleInterviewReminders({ ...interview, startAtUtc: movedStart });
  const rows = await (await jobs()).find({ interviewId: interview._id }).toArray();
  assert.equal(rows.length, 2, 'still one job per recipient');
  for (const row of rows) {
    assert.equal(row.sendAtUtc.getTime(), movedStart.getTime() - HOURS(24));
    assert.equal(row.status, REMINDER_JOB_STATUS.PENDING);
  }
});

test('cancelInterviewReminders flips pending jobs to cancelled', async () => {
  const interview = interviewDoc();
  await scheduleInterviewReminders(interview);
  const flipped = await cancelInterviewReminders(interview._id);
  assert.equal(flipped, 2);
  const rows = await (await jobs()).find({ interviewId: interview._id }).toArray();
  assert.ok(rows.every((row) => row.status === REMINDER_JOB_STATUS.CANCELLED));
});

test('claimDueReminderJob claims only due jobs and increments attemptCount', async () => {
  const dueInterview = interviewDoc({ startAtUtc: new Date(Date.now() + HOURS(48)) });
  await scheduleInterviewReminders(dueInterview);
  assert.equal(await claimDueReminderJob(new Date()), null, 'nothing due yet');
  const later = new Date(Date.now() + HOURS(25));
  const claimed = await claimDueReminderJob(later);
  assert.ok(claimed);
  assert.equal(claimed.status, REMINDER_JOB_STATUS.CLAIMED);
  assert.equal(claimed.attemptCount, 1);
});

test('CONCURRENT CLAIMS: two simultaneous calls return the job to exactly one caller', async () => {
  const interview = interviewDoc();
  await scheduleInterviewReminders(interview);
  // Only one job due: cancel the interviewer job so a single row is claimable.
  await (await jobs()).updateOne({ interviewId: interview._id, recipientKind: 'interviewer' }, { $set: { status: REMINDER_JOB_STATUS.CANCELLED } });
  const later = new Date(Date.now() + HOURS(25));
  const [first, second] = await Promise.all([claimDueReminderJob(later), claimDueReminderJob(later)]);
  const winners = [first, second].filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one caller wins the claim');
});

test('complete / requeue / fail transitions', async () => {
  const interview = interviewDoc();
  await scheduleInterviewReminders(interview);
  const later = new Date(Date.now() + HOURS(25));
  const claimed = await claimDueReminderJob(later);
  await requeueReminderJobWithBackoff(claimed._id, 'smtp down', 30, later);
  let row = await (await jobs()).findOne({ _id: claimed._id });
  assert.equal(row.status, REMINDER_JOB_STATUS.PENDING);
  assert.equal(row.lastError, 'smtp down');
  assert.equal(row.sendAtUtc.getTime(), later.getTime() + 30_000);

  await completeReminderJob(claimed._id);
  row = await (await jobs()).findOne({ _id: claimed._id });
  assert.equal(row.status, REMINDER_JOB_STATUS.COMPLETED);
  assert.ok(row.completedAt instanceof Date);

  const other = await claimDueReminderJob(later); // the second recipient's job
  assert.ok(other && other._id.toString() !== claimed._id.toString());
  await failReminderJob(other._id, 'gave up');
  const failedRow = await (await jobs()).findOne({ _id: other._id });
  assert.equal(failedRow.status, REMINDER_JOB_STATUS.FAILED);
  assert.ok(failedRow.completedAt instanceof Date, 'TTL still reaps failed rows');
});
