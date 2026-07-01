import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureResumeFileIndexes, createResumeFile, attachResumeFileToApplication,
  getResumeFileForApplication,
} from '../../src/models/public/resume-file-model.js';

const APP = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_files');
  await ensureResumeFileIndexes();
}

test('create + attach + getForApplication', async () => {
  const record = await createResumeFile({
    applicationId: null, storagePath: 'data/resumes/abc.pdf',
    originalFilename: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: 1234,
  });
  assert.equal(record.extractedText, null); // filled by Step 6
  await attachResumeFileToApplication(record._id, APP);
  const got = await getResumeFileForApplication(APP);
  assert.equal(got.storagePath, 'data/resumes/abc.pdf');
  assert.equal(got.sizeBytes, 1234);
});
