// FILE: src/models/interview/interview-time-model.js
// interview_times collection — the per-posting availability pool. One document
// per bookable time; each carries a SNAPSHOT of the posting's interviewDefaults
// (duration/mode/meetingUrl/locationText/timezone) frozen at creation, so
// changing the defaults later never silently alters existing pool times.
// Atomic booking + recycling live in interview-time-booking-model.js.
//
// listAvailableTimesForPublicBooking is the ONE unauthenticated read: it takes
// no companyId (the candidate has none) and returns ONLY id/startAtUtc/
// durationMinutes/timezoneId — never mode, meetingUrl, locationText or
// companyId. Those reach the candidate only after booking, via the interview.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { MINIMUM_BOOKING_LEAD_MINUTES } from './interview-constants.js';

export const interviewTimesCol = () => col('interview_times');

export const INTERVIEW_TIME_STATUSES = Object.freeze({
  AVAILABLE: 'available',
  BOOKED: 'booked',
  CANCELLED: 'cancelled',
  PAST: 'past',
});

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const EXPIRED_TTL_SECONDS = 30 * 24 * 60 * 60; // cancelled/past cleaned after 30 days
const DUPLICATE_KEY_CODE = 11000;

export function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

export function leadTimeCutoff(now = new Date()) {
  return new Date(now.getTime() + MINIMUM_BOOKING_LEAD_MINUTES * MILLISECONDS_PER_MINUTE);
}

/** Idempotent index setup. Called on boot. */
export async function ensureInterviewTimeIndexes() {
  const collection = await interviewTimesCol();
  await collection.createIndex(
    { companyId: 1, postingId: 1, status: 1, startAtUtc: 1 },
    { name: 'interview_times_companyId_postingId_status_startAtUtc' },
  );
  await collection.createIndex(
    { companyId: 1, postingId: 1, startAtUtc: 1 },
    { unique: true, name: 'interview_times_companyId_postingId_startAtUtc' },
  );
  await collection.createIndex(
    { bookedByInterviewId: 1 },
    { sparse: true, name: 'interview_times_bookedByInterviewId' },
  );
  await collection.createIndex(
    { startAtUtc: 1 },
    {
      name: 'interview_times_ttl_expired',
      expireAfterSeconds: EXPIRED_TTL_SECONDS,
      partialFilterExpression: { status: { $in: [INTERVIEW_TIME_STATUSES.CANCELLED, INTERVIEW_TIME_STATUSES.PAST] } },
    },
  );
}

/**
 * Insert pool times, snapshotting the interviewDefaults onto each. Unordered
 * insertMany: a duplicate startAtUtc on the same posting (E11000 on the unique
 * index) is silently skipped — adding "3pm Wed" twice creates one, not an
 * error. Returns the count actually inserted.
 */
export async function addTimesForPosting(companyId, postingId, timesArray, interviewDefaults) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  if (!companyOid || !postingOid) throw new Error('addTimesForPosting: invalid ids');
  const now = new Date();
  const docs = timesArray.map((entry) => ({
    companyId: companyOid,
    postingId: postingOid,
    startAtUtc: entry.startAtUtc,
    durationMinutes: interviewDefaults.durationMinutes,
    timezoneId: interviewDefaults.timezoneId,
    mode: interviewDefaults.mode,
    // Link priority: the per-date entry wins, else the posting default, else
    // null — a draft time with no link yet is valid (it can be filled in
    // later by saving a default).
    meetingUrl: entry.meetingUrl ?? interviewDefaults.meetingUrl ?? null,
    locationText: interviewDefaults.locationText ?? null,
    status: INTERVIEW_TIME_STATUSES.AVAILABLE,
    bookedByApplicationId: null,
    bookedByInterviewId: null,
    bookedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const collection = await interviewTimesCol();
  try {
    const result = await collection.insertMany(docs, { ordered: false });
    return result.insertedCount;
  } catch (err) {
    // Unordered insertMany keeps going past duplicates; E11000 survivors are
    // reported on the error. Anything else is a real failure.
    if (err?.code === DUPLICATE_KEY_CODE || err?.writeErrors?.every?.((w) => w.code === DUPLICATE_KEY_CODE)) {
      return err.result?.insertedCount ?? err.insertedCount ?? 0;
    }
    throw err;
  }
}

/** Cancel one AVAILABLE time. A booked time returns null — cancel the interview instead. */
export async function removeTimeForPosting(companyId, postingId, timeId) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  const timeOid = toOid(timeId);
  if (!companyOid || !postingOid || !timeOid) return null;
  return (await interviewTimesCol()).findOneAndUpdate(
    { _id: timeOid, companyId: companyOid, postingId: postingOid, status: INTERVIEW_TIME_STATUSES.AVAILABLE },
    { $set: { status: INTERVIEW_TIME_STATUSES.CANCELLED, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** Employer-side listing, startAtUtc ascending. Past times excluded by default. */
export async function listTimesForPosting(companyId, postingId, { statusFilter, includePast = false } = {}) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  if (!companyOid || !postingOid) return [];
  const query = { companyId: companyOid, postingId: postingOid };
  if (statusFilter) query.status = statusFilter;
  if (!includePast) query.startAtUtc = { $gte: new Date() };
  return (await interviewTimesCol()).find(query).sort({ startAtUtc: 1 }).toArray();
}

/** Available future times, for pool-low checks and gating the send button. */
export async function countAvailableTimesForPosting(companyId, postingId, now = new Date(), { requireMeetingUrl = false } = {}) {
  const companyOid = toOid(companyId);
  const postingOid = toOid(postingId);
  if (!companyOid || !postingOid) return 0;
  const filter = {
    companyId: companyOid,
    postingId: postingOid,
    status: INTERVIEW_TIME_STATUSES.AVAILABLE,
    startAtUtc: { $gt: now },
  };
  // Send-time check: is there a bookable slot that actually carries a link?
  if (requireMeetingUrl) filter.meetingUrl = { $ne: null };
  return (await interviewTimesCol()).countDocuments(filter);
}
