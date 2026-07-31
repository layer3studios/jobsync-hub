import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { cancelInterviewForCompanyWithNotice } from '../../src/services/interview/interview-cancel-service.js';
import {
  ensureInterviewIndexes, createInterviewForCompany, bookInterviewSlot,
  ensureInterviewReminderJobIndexes, scheduleInterviewReminders, REMINDER_JOB_STATUS,
} from '../../src/models/interview/index.js';

const COMPANY_A = new ObjectId();
const ACTOR = new ObjectId();
const HOURS = (n) => n * 60 * 60 * 1000;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'interview_reminder_jobs', 'audit_log');
  await ensureInterviewIndexes();
  await ensureInterviewReminderJobIndexes();
}

async function bookedInterviewWithReminders() {
  const interview = await createInterviewForCompany(COMPANY_A, {
    applicationId: new ObjectId(), postingId: new ObjectId(), contactId: new ObjectId(),
    proposedSlots: [
      { startAtUtc: new Date(Date.now() + HOURS(48)), durationMinutes: 45 },
      { startAtUtc: new Date(Date.now() + HOURS(72)), durationMinutes: 45 },
    ],
    durationMinutes: 45, mode: 'video', meetingUrl: 'https://meet.acme.in/x',
    interviewerEmployerUserIds: [],
  }, ACTOR);
  const { interview: booked } = await bookInterviewSlot(interview.bookingToken, 0);
  await scheduleInterviewReminders(booked);
  return booked;
}

test('cancelling an interview sets its pending reminder jobs to cancelled', async () => {
  const interview = await bookedInterviewWithReminders();
  const cancelled = await cancelInterviewForCompanyWithNotice(
    COMPANY_A, interview._id, 'position filled', ACTOR,
    { buildContext: async () => null }, // related records not seeded — skip emails
  );
  assert.equal(cancelled.status, 'cancelled');
  const rows = await (await col('interview_reminder_jobs')).find({ interviewId: interview._id }).toArray();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === REMINDER_JOB_STATUS.CANCELLED));
});

test('a throwing reminder cancellation never fails the cancel', async () => {
  const interview = await bookedInterviewWithReminders();
  const cancelled = await cancelInterviewForCompanyWithNotice(
    COMPANY_A, interview._id, 'x', ACTOR,
    { buildContext: async () => null, cancelReminders: async () => { throw new Error('boom'); } },
  );
  assert.equal(cancelled.status, 'cancelled');
});
