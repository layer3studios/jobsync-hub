import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  getProfileForUser, upsertProfileForUser, patchProfileForUser, getResumeHashForUser,
  getReviewForUser, upsertReviewForUser, getProfileEnvelopeForUser,
} from '../../src/models/seeker/seeker-profile-helpers.js';

const USER_A = new ObjectId();
const USER_B = new ObjectId();
const PROFILE = { fullName: 'Asha', skills: [{ name: 'Node.js' }], noticePeriod: '30 days' };

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('users');
  const users = await col('users');
  await users.insertMany([
    { _id: USER_A, name: 'A', appliedJobs: [] },
    { _id: USER_B, name: 'B', appliedJobs: [] },
  ]);
}

test('upsertProfileForUser stores profile + hash + timestamps', async () => {
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'hash-abc');
  const users = await col('users');
  const doc = await users.findOne({ _id: USER_A });
  assert.equal(doc.parsedProfile.fullName, 'Asha');
  assert.equal(doc.lastResumeHash, 'hash-abc');
  assert.ok(doc.profileParsedAt instanceof Date);
  assert.ok(doc.profileUpdatedAt instanceof Date);
});

test('upsertProfileForUser returns { matchedCount, modifiedCount, userIdUsed } on success', async () => {
  const result = await upsertProfileForUser(USER_A.toString(), PROFILE, 'hash-ret');
  assert.equal(result.matchedCount, 1);
  assert.equal(result.modifiedCount, 1);
  assert.equal(result.userIdUsed, USER_A.toString());
});

test('upsertProfileForUser accepts an ObjectId userId (the queue-worker path) and writes', async () => {
  const result = await upsertProfileForUser(USER_A, PROFILE, 'hash-oid');
  assert.equal(result.matchedCount, 1);
  assert.equal(result.userIdUsed, USER_A.toString());
  const users = await col('users');
  const doc = await users.findOne({ _id: USER_A });
  assert.equal(doc.lastResumeHash, 'hash-oid');
});

test('upsertProfileForUser returns matchedCount 0 + userIdUsed null on an invalid userId', async () => {
  const result = await upsertProfileForUser('not-a-valid-oid', PROFILE, 'h');
  assert.deepEqual(result, { matchedCount: 0, modifiedCount: 0, userIdUsed: null });
});

test('upsertProfileForUser does not throw when the write matches zero docs', async () => {
  const result = await upsertProfileForUser(new ObjectId().toString(), PROFILE, 'h');
  assert.equal(result.matchedCount, 0);
  assert.equal(typeof result.userIdUsed, 'string');
});

test('getProfileForUser returns the stored profile, null when absent', async () => {
  assert.equal(await getProfileForUser(USER_A.toString()), null);
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'h');
  const got = await getProfileForUser(USER_A.toString());
  assert.equal(got.fullName, 'Asha');
});

test('patchProfileForUser replaces arrays rather than deep-merging', async () => {
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'h');
  const updated = await patchProfileForUser(USER_A.toString(), { skills: [{ name: 'Go' }], fullName: 'Asha Rao' });
  assert.deepEqual(updated.skills, [{ name: 'Go' }]);
  assert.equal(updated.fullName, 'Asha Rao');
  assert.equal(updated.noticePeriod, '30 days'); // untouched field survives
});

test('getResumeHashForUser returns null then the stored hash', async () => {
  assert.equal(await getResumeHashForUser(USER_A.toString()), null);
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'hash-xyz');
  assert.equal(await getResumeHashForUser(USER_A.toString()), 'hash-xyz');
});

test('cross-user isolation: A profile not visible to B', async () => {
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'h');
  assert.equal(await getProfileForUser(USER_B.toString()), null);
});

const REVIEW = { scores: { overall: 72 }, strengths: ['x'], findings: [], topImprovements: [] };

test('getReviewForUser returns null when unset, the stored object when set', async () => {
  assert.equal(await getReviewForUser(USER_A.toString()), null);
  await upsertReviewForUser(USER_A.toString(), REVIEW);
  const got = await getReviewForUser(USER_A.toString());
  assert.equal(got.scores.overall, 72);
});

test('upsertReviewForUser stores resumeReview + profileReviewedAt, leaves parsedProfile', async () => {
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'h');
  await upsertReviewForUser(USER_A.toString(), REVIEW);
  const users = await col('users');
  const doc = await users.findOne({ _id: USER_A });
  assert.equal(doc.resumeReview.scores.overall, 72);
  assert.ok(doc.profileReviewedAt instanceof Date);
  assert.equal(doc.parsedProfile.fullName, 'Asha'); // untouched
});

test('getProfileEnvelopeForUser: unknown user → null profile + empty meta', async () => {
  const env = await getProfileEnvelopeForUser(new ObjectId().toString());
  assert.deepEqual(env, {
    profile: null,
    meta: { profileParsedAt: null, profileUpdatedAt: null, hasResumeOnFile: false },
  });
});

test('getProfileEnvelopeForUser: bad id → empty envelope', async () => {
  const env = await getProfileEnvelopeForUser('not-an-oid');
  assert.equal(env.profile, null);
  assert.equal(env.meta.hasResumeOnFile, false);
});

test('getProfileEnvelopeForUser: with profile + hash → hasResumeOnFile true, ISO timestamps', async () => {
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'hash-abc');
  const env = await getProfileEnvelopeForUser(USER_A.toString());
  assert.equal(env.profile.fullName, 'Asha');
  assert.equal(env.meta.hasResumeOnFile, true);
  assert.equal(typeof env.meta.profileParsedAt, 'string');
  assert.equal(typeof env.meta.profileUpdatedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(env.meta.profileParsedAt)));
});

test('getProfileEnvelopeForUser: legacy profile with no hash → hasResumeOnFile false, parsedAt survives', async () => {
  await upsertProfileForUser(USER_A.toString(), PROFILE, 'hash-abc');
  const users = await col('users');
  await users.updateOne({ _id: USER_A }, { $unset: { lastResumeHash: '' } });
  const env = await getProfileEnvelopeForUser(USER_A.toString());
  assert.equal(env.meta.hasResumeOnFile, false);
  assert.equal(typeof env.meta.profileParsedAt, 'string');
});
