import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureResumeParseJobIndexes, getJobForUser,
} from '../../src/models/seeker/resume-parse-job-model.js';
import { processResumeUpload, processResumeText } from '../../src/services/seeker/resume-upload-service.js';

const USER = new ObjectId();

function makePdf(body) {
  const lines = body.match(/.{1,60}/g) || [body];
  const content = `BT /F1 12 Tf 40 750 Td ${lines.map((l) => `(${l}) Tj 0 -16 Td`).join(' ')} ET`;
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
    + `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`
    + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \ntrailer<</Root 1 0 R/Size 6>>\nstartxref\n0\n%%EOF',
    'latin1',
  );
}
const LONG = 'Senior backend engineer with many years of experience across fintech and ecommerce '
  + 'building distributed systems in Node.js MongoDB and Kubernetes throughout India and beyond. '
  + 'Led platform teams, owned reliability, and mentored engineers across multiple product lines here.';

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('users', 'resume_parse_jobs');
  await ensureResumeParseJobIndexes();
  const users = await col('users');
  await users.insertOne({ _id: USER, name: 'A', appliedJobs: [] });
}

test('new PDF upload enqueues a queued pdf job with a temp file and returns a jobId', async () => {
  const result = await processResumeUpload(USER.toString(), makePdf(LONG));
  assert.equal(result.status, 'queued');
  assert.ok(result.jobId);
  const job = await getJobForUser(USER.toString(), result.jobId);
  assert.equal(job.source, 'pdf');
  assert.ok(job.tmpPath);
  assert.equal(fs.existsSync(path.resolve(job.tmpPath)), true);
  fs.unlinkSync(path.resolve(job.tmpPath)); // keep data/tmp clean between tests
});

test('unchanged hash short-circuits to the stored profile with jobId null (no queue work)', async () => {
  const pdf = makePdf(LONG);
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  await (await col('users')).updateOne(
    { _id: USER },
    { $set: { lastResumeHash: hash, parsedProfile: { fullName: 'Cached' } } },
  );
  const result = await processResumeUpload(USER.toString(), pdf);
  assert.equal(result.isUnchanged, true);
  assert.equal(result.jobId, null);
  assert.equal(result.profile.fullName, 'Cached');
  const jobs = await col('resume_parse_jobs');
  assert.equal(await jobs.countDocuments({ userId: USER }), 0); // nothing enqueued
});

test('text upload enqueues a text job carrying the text inline (no temp file)', async () => {
  const result = await processResumeText(USER.toString(), LONG.repeat(2));
  assert.equal(result.status, 'queued');
  const job = await getJobForUser(USER.toString(), result.jobId);
  assert.equal(job.source, 'text');
  assert.equal(job.tmpPath, null);
  assert.ok(job.resumeText.length > 0);
});
