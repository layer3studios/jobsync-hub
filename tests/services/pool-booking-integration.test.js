// FILE: tests/services/pool-booking-integration.test.js
// End-to-end pool booking through the service layer: link → pick a pool time →
// interview scheduled, time booked, .ics sent, stage advanced — and the
// mismatch/race/recycle paths.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { sendPoolSchedulingLink } from '../../src/services/interview/pool-scheduling-service.js';
import { bookInterviewRequest } from '../../src/services/interview/interview-pool-booking-service.js';
import { getBookingPageDataByToken } from '../../src/services/interview/interview-booking-service.js';
import { cancelInterviewForCompanyWithNotice } from '../../src/services/interview/interview-cancel-service.js';
import {
  ensureInterviewIndexes, ensureInterviewTimeIndexes, ensureInterviewReminderJobIndexes,
  addTimesForPosting, interviewTimesCol, createInterviewForCompany,
  INTERVIEW_ERROR_CODES, INTERVIEW_TIME_STATUSES,
} from '../../src/models/interview/index.js';

const COMPANY_A = new ObjectId();
const ACTOR = new ObjectId();
const HOURS = (n) => new Date(Date.now() + n * 60 * 60 * 1000);
const DEFAULTS = {
  meetingUrl: 'https://meet.acme.in/x', durationMinutes: 45, mode: 'video',
  locationText: null, timezoneId: 'Asia/Kolkata',
};

let postingId; let contactId; let appliedStageId; let interviewStageId;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'interview_times', 'interview_reminder_jobs', 'companies', 'jobs', 'contacts', 'employer_users', 'applications', 'stages', 'stage_changes', 'audit_log');
  await ensureInterviewIndexes(); await ensureInterviewTimeIndexes(); await ensureInterviewReminderJobIndexes();
  postingId = new ObjectId(); contactId = new ObjectId();
  appliedStageId = new ObjectId(); interviewStageId = new ObjectId();
  await (await col('companies')).insertOne({ _id: COMPANY_A, name: 'Acme' });
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: COMPANY_A, title: 'Backend Engineer', interviewDefaults: DEFAULTS });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: COMPANY_A, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('employer_users')).insertOne({ _id: ACTOR, email: 'ravi@acme.in', name: 'Ravi' });
  await (await col('stages')).insertMany([
    { _id: appliedStageId, companyId: COMPANY_A, text: 'Applied', order: 1 },
    { _id: interviewStageId, companyId: COMPANY_A, text: 'Interview', order: 3 },
  ]);
}

async function seedApplication() {
  const applicationId = new ObjectId();
  await (await col('applications')).insertOne({
    _id: applicationId, companyId: COMPANY_A, jobId: postingId, contactId, stageId: appliedStageId, archived: null,
  });
  return applicationId;
}

async function poolInterview(applicationId) {
  return sendPoolSchedulingLink(COMPANY_A, applicationId, ACTOR, { sendInvitationEmail: async () => ({}) });
}

test('booking a pool time schedules the interview, books the time, sends the .ics, moves the stage', async () => {
  const applicationId = await seedApplication();
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(48) }], DEFAULTS);
  const interview = await poolInterview(applicationId);

  const pageData = await getBookingPageDataByToken(interview.bookingToken);
  assert.equal(pageData.times.length, 1, 'pool page carries the times array');
  const messages = [];
  const result = await bookInterviewRequest(interview.bookingToken, { timeId: pageData.times[0].id }, {
    sendEmail: async (message) => { messages.push(message); return { sent: true, code: null, emailId: 'e' }; },
  });
  assert.equal(result.booked, true);
  assert.equal(result.interview.status, 'scheduled');
  assert.equal(result.interview.meetingUrl, DEFAULTS.meetingUrl);
  assert.equal(result.interview.calendarSequence, 1);

  const time = await (await interviewTimesCol()).findOne({ postingId });
  assert.equal(time.status, INTERVIEW_TIME_STATUSES.BOOKED);
  assert.equal(time.bookedByInterviewId.toString(), interview._id.toString());

  assert.ok(messages.length >= 1, 'confirmation email sent');
  assert.equal(messages[0].attachments.length, 1, 'one .ics attached');
  const application = await (await col('applications')).findOne({ _id: applicationId });
  assert.equal(application.stageId.toString(), interviewStageId.toString(), 'stage advanced');
});

test('timeId on a per-candidate interview → MANUAL_REQUIRES_SLOT_INDEX; slotIndex on a pool interview → POOL_REQUIRES_TIME_ID', async () => {
  const manual = await createInterviewForCompany(COMPANY_A, {
    applicationId: new ObjectId(), postingId, contactId,
    proposedSlots: [{ startAtUtc: HOURS(24), durationMinutes: 45 }, { startAtUtc: HOURS(48), durationMinutes: 45 }],
    durationMinutes: 45, mode: 'video', meetingUrl: 'https://meet.acme.in/m', interviewerEmployerUserIds: [],
  }, ACTOR);
  const manualAttempt = await bookInterviewRequest(manual.bookingToken, { timeId: new ObjectId().toString() });
  assert.equal(manualAttempt.booked, false);
  assert.equal(manualAttempt.code, INTERVIEW_ERROR_CODES.MANUAL_REQUIRES_SLOT_INDEX);

  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(48) }], DEFAULTS);
  const pool = await poolInterview(await seedApplication());
  const poolAttempt = await bookInterviewRequest(pool.bookingToken, { slotIndex: 0 });
  assert.equal(poolAttempt.booked, false);
  assert.equal(poolAttempt.code, INTERVIEW_ERROR_CODES.POOL_REQUIRES_TIME_ID);
});

test('cancelling a pool interview recycles its time back to available', async () => {
  const applicationId = await seedApplication();
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(48) }], DEFAULTS);
  const interview = await poolInterview(applicationId);
  const pageData = await getBookingPageDataByToken(interview.bookingToken);
  await bookInterviewRequest(interview.bookingToken, { timeId: pageData.times[0].id }, { sendConfirmationEmails: async () => ({}) });

  const cancelled = await cancelInterviewForCompanyWithNotice(
    COMPANY_A, interview._id, 'position filled', ACTOR, { buildContext: async () => null },
  );
  assert.equal(cancelled.status, 'cancelled');
  const time = await (await interviewTimesCol()).findOne({ postingId });
  assert.equal(time.status, INTERVIEW_TIME_STATUSES.AVAILABLE);
  assert.equal(time.bookedByInterviewId, null);
});

test('TWO-CANDIDATE RACE: same time, one succeeds, the loser refetches and sees fewer times', async () => {
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(48) }, { startAtUtc: HOURS(72) }], DEFAULTS);
  const interviewOne = await poolInterview(await seedApplication());
  const interviewTwo = await poolInterview(await seedApplication());

  const page = await getBookingPageDataByToken(interviewOne.bookingToken);
  assert.equal(page.times.length, 2);
  const contestedTimeId = page.times[0].id;

  const emailDeps = { sendConfirmationEmails: async () => ({}) };
  const [first, second] = await Promise.all([
    bookInterviewRequest(interviewOne.bookingToken, { timeId: contestedTimeId }, emailDeps),
    bookInterviewRequest(interviewTwo.bookingToken, { timeId: contestedTimeId }, emailDeps),
  ]);
  const winners = [first, second].filter((r) => r.booked);
  const losers = [first, second].filter((r) => !r.booked);
  assert.equal(winners.length, 1, 'exactly one candidate gets the time');
  assert.equal(losers[0].code, INTERVIEW_ERROR_CODES.TIME_ALREADY_BOOKED);

  // The loser refetches — one fewer time available.
  const loserToken = first.booked ? interviewTwo.bookingToken : interviewOne.bookingToken;
  const refetched = await getBookingPageDataByToken(loserToken);
  assert.equal(refetched.times.length, 1);
});
