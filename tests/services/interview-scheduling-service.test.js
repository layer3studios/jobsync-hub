import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  proposeInterviewForCompany, rescheduleInterviewForCompany,
} from '../../src/services/interview/interview-scheduling-service.js';
import {
  ensureInterviewIndexes, bookInterviewSlot, INTERVIEW_ERROR_CODES,
} from '../../src/models/interview/index.js';
import { INTERVIEW_MODES } from '../../src/services/email/calendar-invite-constants.js';

const COMPANY_A = new ObjectId();
const COMPANY_B = new ObjectId();
const ACTOR = new ObjectId();
const HOURS_FROM_NOW = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

let applicationId;

async function seed() {
  applicationId = new ObjectId();
  const postingId = new ObjectId();
  const contactId = new ObjectId();
  await (await col('companies')).insertOne({ _id: COMPANY_A, name: 'JobMesh', logoUrl: null, dpoEmail: 'privacy@jobmesh.in' });
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: COMPANY_A, title: 'Backend Engineer' });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: COMPANY_A, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('employer_users')).insertOne({ _id: ACTOR, email: 'ravi@jobmesh.in', name: 'Ravi Recruiter' });
  await (await col('applications')).insertOne({ _id: applicationId, companyId: COMPANY_A, jobId: postingId, contactId });
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'companies', 'jobs', 'contacts', 'employer_users', 'applications', 'audit_log');
  await ensureInterviewIndexes();
  await seed();
}

function input(overrides = {}) {
  return {
    proposedSlots: [
      { startAtUtc: HOURS_FROM_NOW(24), durationMinutes: 45 },
      { startAtUtc: HOURS_FROM_NOW(48), durationMinutes: 45 },
    ],
    durationMinutes: 45,
    mode: INTERVIEW_MODES.VIDEO,
    meetingUrl: 'https://meet.jobmesh.in/room/abc',
    ...overrides,
  };
}

const silentEmailDeps = { sendInvitationEmail: async () => ({}), sendCancelledEmails: async () => ({}) };

test('propose creates the interview, audits it, and fires the invitation', async () => {
  const sent = [];
  const interview = await proposeInterviewForCompany(COMPANY_A, applicationId, input(), ACTOR, {
    sendInvitationEmail: async (context) => { sent.push(context); return { attempted: 1, sent: 1, failed: 0 }; },
  });
  assert.equal(interview.status, 'proposed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].candidateEmail, 'asha@example.com');
  assert.equal(sent[0].organizerEmail, 'ravi@jobmesh.in');
  const audit = await (await col('audit_log')).findOne({ event: 'interview_proposed' });
  assert.ok(audit, 'audit entry missing');
});

test('proposing twice for the same application throws INTERVIEW_ALREADY_ACTIVE', async () => {
  await proposeInterviewForCompany(COMPANY_A, applicationId, input(), ACTOR, silentEmailDeps);
  await assert.rejects(
    () => proposeInterviewForCompany(COMPANY_A, applicationId, input(), ACTOR, silentEmailDeps),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, INTERVIEW_ERROR_CODES.INTERVIEW_ALREADY_ACTIVE);
      return true;
    },
  );
});

test('a cross-tenant applicationId throws 404, not 200', async () => {
  await assert.rejects(
    () => proposeInterviewForCompany(COMPANY_B, applicationId, input(), ACTOR, silentEmailDeps),
    (err) => { assert.equal(err.status, 404); assert.equal(err.code, 'APPLICATION_NOT_FOUND'); return true; },
  );
});

test('a throwing email sender does NOT prevent interview creation', async () => {
  const interview = await proposeInterviewForCompany(COMPANY_A, applicationId, input(), ACTOR, {
    sendInvitationEmail: async () => { throw new Error('smtp exploded'); },
  });
  assert.ok(interview._id);
  assert.equal(interview.status, 'proposed');
});

test('reschedule invalidates the old booking token', async () => {
  const interview = await proposeInterviewForCompany(COMPANY_A, applicationId, input(), ACTOR, silentEmailDeps);
  const booked = await bookInterviewSlot(interview.bookingToken, 0);
  assert.equal(booked.booked, true);

  const rescheduled = await rescheduleInterviewForCompany(
    COMPANY_A, interview._id,
    [{ startAtUtc: HOURS_FROM_NOW(72), durationMinutes: 45 }, { startAtUtc: HOURS_FROM_NOW(96), durationMinutes: 45 }],
    ACTOR, silentEmailDeps,
  );
  assert.equal(rescheduled.status, 'proposed');
  assert.notEqual(rescheduled.bookingToken, interview.bookingToken);
  assert.ok(rescheduled.calendarSequence > booked.interview.calendarSequence);

  const oldTokenAttempt = await bookInterviewSlot(interview.bookingToken, 0);
  assert.equal(oldTokenAttempt.booked, false);
  assert.equal(oldTokenAttempt.code, INTERVIEW_ERROR_CODES.BOOKING_TOKEN_INVALID);

  const newTokenAttempt = await bookInterviewSlot(rescheduled.bookingToken, 0);
  assert.equal(newTokenAttempt.booked, true);
});

test('reschedule of a merely-proposed interview is rejected', async () => {
  const interview = await proposeInterviewForCompany(COMPANY_A, applicationId, input(), ACTOR, silentEmailDeps);
  await assert.rejects(
    () => rescheduleInterviewForCompany(COMPANY_A, interview._id, input().proposedSlots, ACTOR, silentEmailDeps),
    (err) => { assert.equal(err.status, 409); return true; },
  );
});
