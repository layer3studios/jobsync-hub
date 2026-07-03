import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { initGemma } from '../../src/gemma/index.js';
import {
  ensureResumeParseJobIndexes, insertResumeParseJob, getJobForUser,
} from '../../src/models/seeker/resume-parse-job-model.js';
import { tick } from '../../src/services/seeker/resume-parse-worker.js';
import { writeTmpPdf } from '../../src/services/seeker/resume-tmp-storage.js';

const USER = new ObjectId();
const originalFetch = globalThis.fetch;
const LONG = 'Senior backend engineer with many years of experience across fintech and ecommerce '
  + 'building distributed systems in Node.js MongoDB and Kubernetes throughout India and beyond. '
  + 'Led platform teams, owned reliability, and mentored engineers across multiple product lines here.';

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
function stubGemma() {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"fullName":"Asha"}' }] } }] }), text: async () => '' });
  initGemma('fake-key-1');
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); stubGemma(); });
after(async () => { globalThis.fetch = originalFetch; initGemma(''); await closeTestDb(); });
async function reset() {
  await dropCollections('resume_parse_jobs', 'users');
  await ensureResumeParseJobIndexes();
  const users = await col('users');
  await users.insertOne({ _id: USER, name: 'A', appliedJobs: [] });
}

test('tick claims a queued PDF job, parses it, marks done and deletes the temp file', async () => {
  const tmpPath = writeTmpPdf(makePdf(LONG));
  assert.equal(fs.existsSync(path.resolve(tmpPath)), true);
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'pdf', tmpPath, fileHash: 'h1' });

  const ran = await tick();
  assert.equal(ran, true);

  const done = await getJobForUser(USER.toString(), job._id.toString());
  assert.equal(done.status, 'done');
  assert.equal(done.result.profile.fullName, 'Asha');
  assert.equal(done.result.isUnchanged, false);
  assert.equal(fs.existsSync(path.resolve(tmpPath)), false); // C8 cleanup
});

test('tick processes an inline text job without any temp file', async () => {
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: LONG, fileHash: 'h2' });
  await tick();
  const done = await getJobForUser(USER.toString(), job._id.toString());
  assert.equal(done.status, 'done');
  assert.equal(done.result.profile.fullName, 'Asha');
});

test('a parse failure is caught, marked failed with a code, and still cleans the temp file', async () => {
  initGemma(''); // no Gemma client → parseResumeText throws GEMMA_UNAVAILABLE
  const tmpPath = writeTmpPdf(makePdf(LONG));
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'pdf', tmpPath, fileHash: 'h3' });

  const ran = await tick();
  assert.equal(ran, true);

  const failed = await getJobForUser(USER.toString(), job._id.toString());
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'GEMMA_UNAVAILABLE');
  assert.equal(fs.existsSync(path.resolve(tmpPath)), false);
});

test('tick returns false when the queue is empty', async () => {
  assert.equal(await tick(), false);
});
