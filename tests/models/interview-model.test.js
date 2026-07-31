import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureInterviewIndexes, createInterviewForCompany, getInterviewForCompany,
  listInterviewsForApplication, cancelInterviewForCompany,
  toPublicInterview, toCandidateInterview, bookInterviewSlot, interviewsCol,
  INTERVIEW_STATUSES, INTERVIEW_ERROR_CODES, INTERVIEW_MODES,
} from '../../src/models/interview/index.js';

const COMPANY_A = new ObjectId();
const COMPANY_B = new ObjectId();
const APPLICATION_1 = new ObjectId();
const CREATOR = new ObjectId();
const HOURS_FROM_NOW = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

function baseInput(overrides = {}) {
  return {
    applicationId: APPLICATION_1,
    postingId: new ObjectId(),
    contactId: new ObjectId(),
    proposedSlots: [
      { startAtUtc: HOURS_FROM_NOW(24), durationMinutes: 45 },
      { startAtUtc: HOURS_FROM_NOW(48), durationMinutes: 45 },
    ],
    durationMinutes: 45,
    mode: INTERVIEW_MODES.VIDEO,
    meetingUrl: 'https://meet.jobmesh.in/room/abc',
    interviewerEmployerUserIds: [new ObjectId()],
    ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews');
  await ensureInterviewIndexes();
}

test('create returns calendarUid, sequence 0, status proposed, base64url token', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  assert.match(interview.calendarUid, /^interview-[0-9a-f-]{36}@jobmesh\.in$/);
  assert.equal(interview.calendarSequence, 0);
  assert.equal(interview.status, INTERVIEW_STATUSES.PROPOSED);
  // 32 random bytes → 43 base64url chars, no padding.
  assert.match(interview.bookingToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(interview.googleCalendarEventId, null);
});

test('getInterviewForCompany with a different companyId returns null (cross-tenant)', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  assert.equal(await getInterviewForCompany(COMPANY_B, interview._id), null);
  assert.ok(await getInterviewForCompany(COMPANY_A, interview._id));
});

test('listInterviewsForApplication with a different companyId returns []', async () => {
  await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  assert.deepEqual(await listInterviewsForApplication(COMPANY_B, APPLICATION_1), []);
  assert.equal((await listInterviewsForApplication(COMPANY_A, APPLICATION_1)).length, 1);
});

test('bookInterviewSlot happy path schedules and bumps sequence to 1', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const result = await bookInterviewSlot(interview.bookingToken, 1);
  assert.equal(result.booked, true);
  assert.equal(result.code, null);
  assert.equal(result.interview.status, INTERVIEW_STATUSES.SCHEDULED);
  assert.equal(result.interview.selectedSlotIndex, 1);
  assert.equal(result.interview.startAtUtc.getTime(), interview.proposedSlots[1].startAtUtc.getTime());
  assert.equal(result.interview.calendarSequence, 1);
  assert.ok(result.interview.bookedAt instanceof Date);
});

test('double booking: second attempt is a no-op with INTERVIEW_NOT_PROPOSED', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const first = await bookInterviewSlot(interview.bookingToken, 0);
  const second = await bookInterviewSlot(interview.bookingToken, 0);
  assert.equal(first.booked, true);
  assert.equal(second.booked, false);
  assert.equal(second.code, INTERVIEW_ERROR_CODES.INTERVIEW_NOT_PROPOSED);
  const stored = await getInterviewForCompany(COMPANY_A, interview._id);
  assert.equal(stored.calendarSequence, 1, 'sequence must be 1, not 2');
});

test('expired token returns BOOKING_TOKEN_EXPIRED', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  await (await interviewsCol()).updateOne(
    { _id: interview._id },
    { $set: { bookingTokenExpiresAt: new Date(Date.now() - 1000) } },
  );
  const result = await bookInterviewSlot(interview.bookingToken, 0);
  assert.equal(result.booked, false);
  assert.equal(result.code, INTERVIEW_ERROR_CODES.BOOKING_TOKEN_EXPIRED);
});

test('unknown token returns BOOKING_TOKEN_INVALID', async () => {
  const result = await bookInterviewSlot('definitely-not-a-real-token', 0);
  assert.equal(result.booked, false);
  assert.equal(result.code, INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID);
});

test('a slot starting 10 minutes from now returns SLOT_TOO_SOON', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput({
    proposedSlots: [
      { startAtUtc: new Date(Date.now() + 10 * 60 * 1000), durationMinutes: 45 },
      { startAtUtc: HOURS_FROM_NOW(48), durationMinutes: 45 },
    ],
  }), CREATOR);
  const result = await bookInterviewSlot(interview.bookingToken, 0);
  assert.equal(result.booked, false);
  assert.equal(result.code, INTERVIEW_ERROR_CODES.SLOT_TOO_SOON);
});

test('slotIndex 99 returns INVALID_SLOT', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const result = await bookInterviewSlot(interview.bookingToken, 99);
  assert.equal(result.booked, false);
  assert.equal(result.code, INTERVIEW_ERROR_CODES.INVALID_SLOT);
});

test('cancelInterviewForCompany bumps sequence and stamps cancelledAt', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const cancelled = await cancelInterviewForCompany(COMPANY_A, interview._id, 'position filled');
  assert.equal(cancelled.status, INTERVIEW_STATUSES.CANCELLED);
  assert.equal(cancelled.calendarSequence, 1);
  assert.ok(cancelled.cancelledAt instanceof Date);
  assert.equal(cancelled.cancelReason, 'position filled');
});

test('cancelInterviewForCompany with a wrong companyId returns null', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  assert.equal(await cancelInterviewForCompany(COMPANY_B, interview._id, 'x'), null);
});

test('toPublicInterview never contains bookingToken', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const publicShape = toPublicInterview(interview);
  assert.equal('bookingToken' in publicShape, false);
  assert.equal(JSON.stringify(publicShape).includes(interview.bookingToken), false);
});

test('toCandidateInterview exposes locationText for in_person only', async () => {
  const inPerson = await createInterviewForCompany(COMPANY_A, baseInput({
    mode: INTERVIEW_MODES.IN_PERSON, meetingUrl: null, locationText: 'JobMesh HQ, Bengaluru',
  }), CREATOR);
  assert.equal(toCandidateInterview(inPerson).locationText, 'JobMesh HQ, Bengaluru');
  const video = await createInterviewForCompany(COMPANY_A, baseInput({ applicationId: new ObjectId() }), CREATOR);
  assert.equal(toCandidateInterview(video).locationText, null);
  assert.equal('meetingUrl' in toCandidateInterview(video), false);
});

test('toCandidateInterview includes bookingTokenExpiresAt and cancelReason', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const candidateShape = toCandidateInterview(interview);
  assert.ok(candidateShape.bookingTokenExpiresAt instanceof Date);
  assert.equal(candidateShape.cancelReason, null);
  assert.equal(toCandidateInterview({ ...interview, cancelReason: 'Position filled' }).cancelReason, 'Position filled');
});

test('toCandidateInterview leaks no tenant data', async () => {
  const interview = await createInterviewForCompany(COMPANY_A, baseInput(), CREATOR);
  const candidateShape = toCandidateInterview(interview);
  for (const forbiddenField of [
    'companyId', 'applicationId', 'contactId', 'interviewerEmployerUserIds',
    'calendarUid', 'bookingToken', 'postingId', 'createdByEmployerUserId',
  ]) {
    assert.equal(forbiddenField in candidateShape, false, `${forbiddenField} must not be exposed`);
  }
  const serialized = JSON.stringify(candidateShape);
  assert.equal(serialized.includes(COMPANY_A.toString()), false);
  assert.equal(serialized.includes(interview.bookingToken), false);
});
