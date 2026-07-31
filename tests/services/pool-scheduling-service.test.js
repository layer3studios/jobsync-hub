import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { sendPoolSchedulingLink } from '../../src/services/interview/pool-scheduling-service.js';
import {
  ensureInterviewIndexes, ensureInterviewTimeIndexes, addTimesForPosting, INTERVIEW_ERROR_CODES,
} from '../../src/models/interview/index.js';
import { buildInterviewInvitationEmail } from '../../src/services/email/templates/interview-invitation-template.js';

const COMPANY_A = new ObjectId();
const ACTOR = new ObjectId();
const HOURS = (n) => new Date(Date.now() + n * 60 * 60 * 1000);
const DEFAULTS = {
  meetingUrl: 'https://meet.acme.in/x', durationMinutes: 45, mode: 'video',
  locationText: null, timezoneId: 'Asia/Kolkata',
};

let postingId; let contactId; let applicationId;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'interview_times', 'companies', 'jobs', 'contacts', 'employer_users', 'applications', 'audit_log');
  await ensureInterviewIndexes(); await ensureInterviewTimeIndexes();
  postingId = new ObjectId(); contactId = new ObjectId(); applicationId = new ObjectId();
  await (await col('companies')).insertOne({ _id: COMPANY_A, name: 'Acme' });
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: COMPANY_A, title: 'Backend Engineer', interviewDefaults: DEFAULTS });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: COMPANY_A, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('employer_users')).insertOne({ _id: ACTOR, email: 'ravi@acme.in', name: 'Ravi' });
  await (await col('applications')).insertOne({ _id: applicationId, companyId: COMPANY_A, jobId: postingId, contactId });
}

const silentDeps = { sendInvitationEmail: async () => ({}) };

async function expectHttpError(fn, status, code) {
  await assert.rejects(fn, (err) => { assert.equal(err.status, status); assert.equal(err.code, code); return true; });
}

test('no interviewDefaults → 400 NO_INTERVIEW_DEFAULTS', async () => {
  await (await col('jobs')).updateOne({ _id: postingId }, { $unset: { interviewDefaults: '' } });
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(24) }], DEFAULTS);
  await expectHttpError(
    () => sendPoolSchedulingLink(COMPANY_A, applicationId, ACTOR, silentDeps),
    400, INTERVIEW_ERROR_CODES.NO_INTERVIEW_DEFAULTS,
  );
});

test('POOL-EMPTY GATE: zero available times → 400 POOL_EMPTY', async () => {
  await expectHttpError(
    () => sendPoolSchedulingLink(COMPANY_A, applicationId, ACTOR, silentDeps),
    400, INTERVIEW_ERROR_CODES.POOL_EMPTY,
  );
});

test('an active interview → 409 INTERVIEW_ALREADY_ACTIVE', async () => {
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(24) }], DEFAULTS);
  await sendPoolSchedulingLink(COMPANY_A, applicationId, ACTOR, silentDeps);
  await expectHttpError(
    () => sendPoolSchedulingLink(COMPANY_A, applicationId, ACTOR, silentDeps),
    409, INTERVIEW_ERROR_CODES.INTERVIEW_ALREADY_ACTIVE,
  );
});

test('happy path creates a proposed interview with source pool and empty slots', async () => {
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS(24) }], DEFAULTS);
  const sent = [];
  const interview = await sendPoolSchedulingLink(COMPANY_A, applicationId, ACTOR, {
    sendInvitationEmail: async (context) => { sent.push(context); return {}; },
  });
  assert.equal(interview.source, 'pool');
  assert.equal(interview.status, 'proposed');
  assert.deepEqual(interview.proposedSlots, []);
  assert.equal(interview.meetingUrl, DEFAULTS.meetingUrl);
  assert.equal(sent.length, 1);
  assert.ok(await (await col('audit_log')).findOne({ event: 'interview_proposed' }));
});

test('the pool invitation email says "Choose a time", lists no specific times', () => {
  const { html, text } = buildInterviewInvitationEmail({
    candidateName: 'Asha', companyName: 'Acme', postingTitle: 'Backend Engineer',
    proposedSlots: [], timezoneId: 'Asia/Kolkata', durationMinutes: 45,
    mode: 'video', locationText: null,
    bookingUrl: 'https://jobmesh.in/interview/tok', expiresAt: HOURS(7 * 24),
  });
  assert.ok(text.includes('Choose a time that works for you'));
  assert.ok(!text.includes('Option 1'), 'no specific time listed');
  assert.ok(html.includes('Choose a time that works for you'));
});
