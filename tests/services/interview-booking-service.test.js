import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  bookInterviewByToken, getBookingPageDataByToken,
} from '../../src/services/interview/interview-booking-service.js';
import {
  ensureInterviewIndexes, createInterviewForCompany, interviewsCol,
} from '../../src/models/interview/index.js';
import { CALENDAR_INVITE_CONTENT_TYPE } from '../../src/services/email/email-constants.js';
import { INTERVIEW_MODES } from '../../src/services/email/calendar-invite-constants.js';

const COMPANY_A = new ObjectId();
const CREATOR = new ObjectId();
const INTERVIEWER = new ObjectId();
const HOURS_FROM_NOW = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

let postingId; let contactId;

async function seed() {
  postingId = new ObjectId();
  contactId = new ObjectId();
  await (await col('companies')).insertOne({ _id: COMPANY_A, name: 'JobMesh', logoUrl: 'https://cdn.jobmesh.in/logo.png' });
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: COMPANY_A, title: 'Backend Engineer' });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: COMPANY_A, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('employer_users')).insertOne({ _id: CREATOR, email: 'ravi@jobmesh.in', name: 'Ravi Recruiter' });
  await (await col('employer_users')).insertOne({ _id: INTERVIEWER, email: 'lead@jobmesh.in', name: 'Lead' });
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'companies', 'jobs', 'contacts', 'employer_users', 'stages', 'stage_changes', 'applications', 'interview_reminder_jobs');
  await ensureInterviewIndexes();
  await seed();
}

// Seed a real pipeline (Applied < Interview < Offer) + an application row so the
// booking's stage auto-advance has something to move.
async function seedPipeline(startStageText = 'Applied') {
  const stages = [
    { _id: new ObjectId(), companyId: COMPANY_A, text: 'Applied', order: 1 },
    { _id: new ObjectId(), companyId: COMPANY_A, text: 'Interview', order: 3 },
    { _id: new ObjectId(), companyId: COMPANY_A, text: 'Offer', order: 4 },
  ];
  await (await col('stages')).insertMany(stages);
  const startStage = stages.find((stage) => stage.text === startStageText);
  const applicationId = new ObjectId();
  await (await col('applications')).insertOne({
    _id: applicationId, companyId: COMPANY_A, jobId: postingId, contactId,
    stageId: startStage._id, archived: null,
  });
  return { applicationId, stages };
}

function createInterview(overrides = {}) {
  return createInterviewForCompany(COMPANY_A, {
    applicationId: new ObjectId(),
    postingId,
    contactId,
    proposedSlots: [
      { startAtUtc: HOURS_FROM_NOW(24), durationMinutes: 45 },
      { startAtUtc: HOURS_FROM_NOW(48), durationMinutes: 45 },
    ],
    durationMinutes: 45,
    mode: INTERVIEW_MODES.VIDEO,
    meetingUrl: 'https://meet.jobmesh.in/room/abc',
    interviewerEmployerUserIds: [INTERVIEWER],
    ...overrides,
  }, CREATOR);
}

test('booking sends exactly one .ics per recipient with the calendar contentType', async () => {
  const interview = await createInterview();
  const messages = [];
  const sendEmail = async (message) => { messages.push(message); return { sent: true, code: null, emailId: 'e1' }; };
  const result = await bookInterviewByToken(interview.bookingToken, 0, { sendEmail });
  assert.equal(result.booked, true);
  assert.equal(messages.length, 2, 'candidate + one interviewer');
  for (const message of messages) {
    assert.equal(message.attachments.length, 1, 'exactly ONE .ics, nothing else');
    assert.equal(message.attachments[0].contentType, CALENDAR_INVITE_CONTENT_TYPE);
  }
  assert.deepEqual(messages.map((m) => m.to).sort(), ['asha@example.com', 'lead@jobmesh.in']);
});

test('a failed booking returns the model code unchanged and sends nothing', async () => {
  const messages = [];
  const sendEmail = async (message) => { messages.push(message); return { sent: true, code: null, emailId: 'e1' }; };
  const result = await bookInterviewByToken('unknown-token', 0, { sendEmail });
  assert.equal(result.booked, false);
  assert.equal(result.code, 'BOOKING_TOKEN_INVALID');
  assert.equal(messages.length, 0);
});

test('a throwing email pipeline never fails the booking', async () => {
  const interview = await createInterview();
  const result = await bookInterviewByToken(interview.bookingToken, 0, {
    sendConfirmationEmails: async () => { throw new Error('boom'); },
  });
  assert.equal(result.booked, true);
});

test('getBookingPageDataByToken leaks no internal identifiers', async () => {
  const interview = await createInterview({ mode: INTERVIEW_MODES.IN_PERSON, meetingUrl: null, locationText: 'JobMesh HQ, Bengaluru' });
  const pageData = await getBookingPageDataByToken(interview.bookingToken);
  assert.equal(pageData.companyName, 'JobMesh');
  assert.equal(pageData.postingTitle, 'Backend Engineer');
  assert.equal(pageData.companyLogoUrl, 'https://cdn.jobmesh.in/logo.png');
  assert.equal(pageData.locationText, 'JobMesh HQ, Bengaluru');
  const serialized = JSON.stringify(pageData);
  for (const [label, value] of [
    ['companyId', COMPANY_A.toString()],
    ['applicationId', interview.applicationId.toString()],
    ['contactId', contactId.toString()],
    ['calendarUid', interview.calendarUid],
    ['bookingToken', interview.bookingToken],
  ]) {
    assert.equal(serialized.includes(value), false, `${label} leaked to the public page`);
  }
});

test('unknown token returns null; expired token returns { expired: true, companyName }', async () => {
  assert.equal(await getBookingPageDataByToken('unknown-token'), null);
  const interview = await createInterview();
  await (await interviewsCol()).updateOne(
    { _id: interview._id },
    { $set: { bookingTokenExpiresAt: new Date(Date.now() - 1000) } },
  );
  assert.deepEqual(await getBookingPageDataByToken(interview.bookingToken), { expired: true, companyName: 'JobMesh' });
});

test('booking moves the application to the Interview stage with a stage-change row', async () => {
  const { applicationId, stages } = await seedPipeline('Applied');
  const interview = await createInterview({ applicationId });
  const result = await bookInterviewByToken(interview.bookingToken, 0, { sendConfirmationEmails: async () => ({}) });
  assert.equal(result.booked, true);
  const application = await (await col('applications')).findOne({ _id: applicationId });
  const interviewStage = stages.find((stage) => stage.text === 'Interview');
  assert.equal(application.stageId.toString(), interviewStage._id.toString());
  const change = await (await col('stage_changes')).findOne({ applicationId });
  assert.ok(change, 'stage history recorded');
  assert.equal(change.movedByUserId, null, 'attributed to the booking, not a person');
});

test('booking with no Interview stage configured still succeeds', async () => {
  const applicationId = new ObjectId();
  await (await col('applications')).insertOne({
    _id: applicationId, companyId: COMPANY_A, jobId: postingId, contactId, stageId: new ObjectId(), archived: null,
  });
  const interview = await createInterview({ applicationId });
  const result = await bookInterviewByToken(interview.bookingToken, 0, { sendConfirmationEmails: async () => ({}) });
  assert.equal(result.booked, true);
});

test('booking does not move an application already past the Interview stage', async () => {
  const { applicationId, stages } = await seedPipeline('Offer');
  const interview = await createInterview({ applicationId });
  const result = await bookInterviewByToken(interview.bookingToken, 0, { sendConfirmationEmails: async () => ({}) });
  assert.equal(result.booked, true);
  const application = await (await col('applications')).findOne({ _id: applicationId });
  const offerStage = stages.find((stage) => stage.text === 'Offer');
  assert.equal(application.stageId.toString(), offerStage._id.toString(), 'never moved backwards');
});

test('booking schedules candidate + interviewer reminder jobs', async () => {
  const interview = await createInterview();
  // Slot 1 starts 48h out — outside the 24h lead window, so reminders schedule.
  await bookInterviewByToken(interview.bookingToken, 1, { sendConfirmationEmails: async () => ({}) });
  const count = await (await col('interview_reminder_jobs')).countDocuments({ interviewId: interview._id });
  assert.equal(count, 2);
});
