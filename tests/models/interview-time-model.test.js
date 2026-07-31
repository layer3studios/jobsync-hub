import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureInterviewTimeIndexes, addTimesForPosting, removeTimeForPosting,
  listTimesForPosting, countAvailableTimesForPosting, interviewTimesCol,
  INTERVIEW_TIME_STATUSES,
} from '../../src/models/interview/interview-time-model.js';
import {
  listAvailableTimesForPublicBooking, bookTimeAtomically, recycleTimeFromCancelledInterview,
} from '../../src/models/interview/interview-time-booking-model.js';
import { INTERVIEW_ERROR_CODES } from '../../src/models/interview/interview-constants.js';

const COMPANY_A = new ObjectId();
const COMPANY_B = new ObjectId();
const POSTING_1 = new ObjectId();
const HOURS = (n) => new Date(Date.now() + n * 60 * 60 * 1000);
const DEFAULTS = {
  meetingUrl: 'https://meet.acme.in/x', durationMinutes: 45, mode: 'video',
  locationText: null, timezoneId: 'Asia/Kolkata',
};

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interview_times');
  await ensureInterviewTimeIndexes();
}

async function seedTimes(hoursList = [24, 48, 72]) {
  await addTimesForPosting(COMPANY_A, POSTING_1, hoursList.map((h) => ({ startAtUtc: HOURS(h) })), DEFAULTS);
  return (await interviewTimesCol()).find({ postingId: POSTING_1 }).sort({ startAtUtc: 1 }).toArray();
}

test('addTimesForPosting inserts the right count, all available, defaults snapshotted', async () => {
  const rows = await seedTimes();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, INTERVIEW_TIME_STATUSES.AVAILABLE);
    assert.equal(row.durationMinutes, 45);
    assert.equal(row.meetingUrl, 'https://meet.acme.in/x');
    assert.equal(row.mode, 'video');
  }
});

test('DUPLICATE SKIP: same startAtUtc on the same posting silently skips', async () => {
  const sharedStart = HOURS(24);
  const first = await addTimesForPosting(COMPANY_A, POSTING_1, [{ startAtUtc: sharedStart }], DEFAULTS);
  const second = await addTimesForPosting(COMPANY_A, POSTING_1, [{ startAtUtc: sharedStart }, { startAtUtc: HOURS(48) }], DEFAULTS);
  assert.equal(first, 1);
  assert.equal(second, 1, 'the duplicate is skipped, the new one inserts');
  assert.equal(await (await interviewTimesCol()).countDocuments({ postingId: POSTING_1 }), 2);
});

test('bookTimeAtomically happy path books and returns the time', async () => {
  const [time] = await seedTimes([24]);
  const result = await bookTimeAtomically(time._id, new ObjectId(), new ObjectId());
  assert.equal(result.booked, true);
  assert.equal(result.time.status, INTERVIEW_TIME_STATUSES.BOOKED);
  assert.ok(result.time.bookedAt instanceof Date);
});

test('TWO-CANDIDATE RACE: concurrent booking of the same time — exactly one wins', async () => {
  const [time] = await seedTimes([24]);
  const [first, second] = await Promise.all([
    bookTimeAtomically(time._id, new ObjectId(), new ObjectId()),
    bookTimeAtomically(time._id, new ObjectId(), new ObjectId()),
  ]);
  const winners = [first, second].filter((r) => r.booked);
  const losers = [first, second].filter((r) => !r.booked);
  assert.equal(winners.length, 1, 'exactly one booking succeeds');
  assert.equal(losers[0].code, INTERVIEW_ERROR_CODES.TIME_ALREADY_BOOKED);
});

test('a time starting 10 minutes from now returns TIME_TOO_SOON', async () => {
  await addTimesForPosting(COMPANY_A, POSTING_1, [{ startAtUtc: new Date(Date.now() + 10 * 60 * 1000) }], DEFAULTS);
  const [time] = await (await interviewTimesCol()).find({}).toArray();
  const result = await bookTimeAtomically(time._id, new ObjectId(), new ObjectId());
  assert.equal(result.booked, false);
  assert.equal(result.code, INTERVIEW_ERROR_CODES.TIME_TOO_SOON);
});

test('removeTimeForPosting cancels an available time; a booked time returns null', async () => {
  const [available, toBook] = await seedTimes([24, 48]);
  await bookTimeAtomically(toBook._id, new ObjectId(), new ObjectId());
  const removed = await removeTimeForPosting(COMPANY_A, POSTING_1, available._id);
  assert.equal(removed.status, INTERVIEW_TIME_STATUSES.CANCELLED);
  assert.equal(await removeTimeForPosting(COMPANY_A, POSTING_1, toBook._id), null);
});

test('RECYCLE: a booked time returns to available; manual interviews return null', async () => {
  const [time] = await seedTimes([24]);
  const interviewId = new ObjectId();
  await bookTimeAtomically(time._id, new ObjectId(), interviewId);
  const recycled = await recycleTimeFromCancelledInterview(interviewId);
  assert.equal(recycled.status, INTERVIEW_TIME_STATUSES.AVAILABLE);
  assert.equal(recycled.bookedByInterviewId, null);
  assert.equal(recycled.bookedByApplicationId, null);
  assert.equal(await recycleTimeFromCancelledInterview(new ObjectId()), null, 'no pool time → null');
});

test('listAvailableTimesForPublicBooking excludes booked, cancelled, past, too-soon', async () => {
  const rows = await seedTimes([24, 48, 72]);
  await bookTimeAtomically(rows[0]._id, new ObjectId(), new ObjectId());
  await removeTimeForPosting(COMPANY_A, POSTING_1, rows[1]._id);
  await addTimesForPosting(COMPANY_A, POSTING_1, [{ startAtUtc: new Date(Date.now() + 30 * 60 * 1000) }], DEFAULTS); // too soon
  await (await interviewTimesCol()).insertOne({
    companyId: COMPANY_A, postingId: POSTING_1, startAtUtc: new Date(Date.now() - 1000),
    durationMinutes: 45, timezoneId: 'Asia/Kolkata', mode: 'video', meetingUrl: null, locationText: null,
    status: INTERVIEW_TIME_STATUSES.AVAILABLE, bookedByApplicationId: null, bookedByInterviewId: null,
    bookedAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  const publicTimes = await listAvailableTimesForPublicBooking(POSTING_1);
  assert.equal(publicTimes.length, 1, 'only the 72h available time survives');
});

test('public list exposes ONLY id, startAtUtc, durationMinutes, timezoneId', async () => {
  await seedTimes([24]);
  const [entry] = await listAvailableTimesForPublicBooking(POSTING_1);
  assert.deepEqual(Object.keys(entry).sort(), ['durationMinutes', 'id', 'startAtUtc', 'timezoneId']);
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes(COMPANY_A.toString()), false);
  assert.equal(serialized.includes('meet.acme.in'), false);
});

test('countAvailableTimesForPosting excludes past and booked', async () => {
  const rows = await seedTimes([24, 48]);
  await bookTimeAtomically(rows[0]._id, new ObjectId(), new ObjectId());
  assert.equal(await countAvailableTimesForPosting(COMPANY_A, POSTING_1), 1);
});

test('CROSS-TENANT: listTimesForPosting with the wrong companyId returns []', async () => {
  await seedTimes();
  assert.deepEqual(await listTimesForPosting(COMPANY_B, POSTING_1), []);
  assert.equal((await listTimesForPosting(COMPANY_A, POSTING_1)).length, 3);
});
