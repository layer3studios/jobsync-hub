import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { initGemma } from '../../src/gemma/index.js';
import { upsertProfileForUser, getReviewForUser } from '../../src/models/seeker/seeker-profile-helpers.js';
import { runResumeReviewForUser, getResumeReviewForUser } from '../../src/services/seeker/resume-review-service.js';

const USER = new ObjectId();
const originalFetch = globalThis.fetch;
const PROFILE = { fullName: 'Asha', experience: [{ responsibilities: ['Worked on APIs'] }] };

const REVIEW_JSON = JSON.stringify({
  scores: { parseability: 80, contentStrength: 60, indiaMarketFit: 70, skillsDepth: 50 },
  strengths: ['Solid Node.js depth'],
  findings: [{ section: 'EXPERIENCE', severity: 'warning', message: 'Weak verb', sourceEvidence: 'Worked on APIs' }],
  topImprovements: [{ title: 'Quantify', why: 'scope', observedBullet: 'Worked on APIs', question: 'How many APIs and what scale?' }],
});

/** Stub global fetch to return a canned Gemma response, then (re)init the client. */
function withGemma(raw) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: raw }] } }] }),
    text: async () => '',
  });
  initGemma('fake-key-1');
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { globalThis.fetch = originalFetch; initGemma(''); await closeTestDb(); });
async function reset() {
  await dropCollections('users');
  const users = await col('users');
  await users.insertOne({ _id: USER, name: 'A', appliedJobs: [] });
  withGemma(REVIEW_JSON);
}

test('no parsedProfile → HttpError 400 NO_PROFILE', async () => {
  await assert.rejects(
    () => runResumeReviewForUser(USER.toString()),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'NO_PROFILE'); return true; },
  );
});

test('Gemma client null → HttpError 503 GEMMA_UNAVAILABLE', async () => {
  await upsertProfileForUser(USER.toString(), PROFILE, 'h');
  initGemma(''); // no keys → null client
  await assert.rejects(
    () => runResumeReviewForUser(USER.toString()),
    (err) => { assert.equal(err.status, 503); assert.equal(err.code, 'GEMMA_UNAVAILABLE'); return true; },
  );
});

test('happy path persists the review and returns it', async () => {
  await upsertProfileForUser(USER.toString(), PROFILE, 'h');
  const review = await runResumeReviewForUser(USER.toString());
  assert.equal(review.scores.parseability, 80);
  assert.equal(review.findings[0].section, 'EXPERIENCE');
  const stored = await getReviewForUser(USER.toString());
  assert.equal(stored.scores.parseability, 80);
  assert.equal(await getResumeReviewForUser(USER.toString()) !== null, true);
});

test('Gemma returns unparseable output → HttpError 422 REVIEW_PARSE_FAILED', async () => {
  await upsertProfileForUser(USER.toString(), PROFILE, 'h');
  withGemma('not json at all');
  await assert.rejects(
    () => runResumeReviewForUser(USER.toString()),
    (err) => { assert.equal(err.status, 422); assert.equal(err.code, 'REVIEW_PARSE_FAILED'); return true; },
  );
});
