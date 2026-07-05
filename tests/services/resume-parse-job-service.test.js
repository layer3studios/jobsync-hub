import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureResumeParseJobIndexes, insertResumeParseJob, markJobDone,
} from '../../src/models/seeker/resume-parse-job-model.js';
import { getJobStatusForUser } from '../../src/services/seeker/resume-parse-job-service.js';

const USER = new ObjectId();
const OTHER = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_parse_jobs');
  await ensureResumeParseJobIndexes();
}

test('returns the public job status for its owner', async () => {
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 'secret text', fileHash: 'h1' });
  await markJobDone(job._id, { profile: { fullName: 'Asha' }, isUnchanged: false });

  const status = await getJobStatusForUser(USER.toString(), job._id.toString());
  assert.equal(status.status, 'done');
  assert.equal(status.result.profile.fullName, 'Asha');
  assert.equal('resumeText' in status, false); // never leaks the stored text
});

test('returns null when the job belongs to another user (no cross-user leak)', async () => {
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 't', fileHash: 'h1' });
  assert.equal(await getJobStatusForUser(OTHER.toString(), job._id.toString()), null);
});

test('returns null for an unknown or malformed jobId', async () => {
  assert.equal(await getJobStatusForUser(USER.toString(), new ObjectId().toString()), null);
  assert.equal(await getJobStatusForUser(USER.toString(), 'not-an-id'), null);
});
