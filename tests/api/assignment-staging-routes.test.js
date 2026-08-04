// FILE: tests/api/assignment-staging-routes.test.js
// No DB — the staging endpoint is deliberately cookie-less and stateless, so this
// suite exercises multer + the filesystem only. Every file written is removed in
// after() by diffing the staging directory against a snapshot taken up front.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import assignmentStagingRouter, { stagingRateLimitStore } from '../../src/api/public/assignment-staging-routes.js';
import {
  ensureAssignmentDirectories, stagingDirectoryPath,
} from '../../src/services/public/assignment-storage-service.js';
import { verifyStagedFileToken } from '../../src/services/employer/assignment-signed-url-service.js';

const STAGING_DIR = stagingDirectoryPath();
let preExisting = new Set();

function buildApp() {
  const app = express();
  app.use('/api/public/assignment-files', assignmentStagingRouter);
  app.use(errorHandler);
  return app;
}

const listStaging = () => fs.readdirSync(STAGING_DIR);
/** Files this suite is responsible for — anything that was not there at start. */
const ourFiles = () => listStaging().filter((name) => !preExisting.has(name));

const post = (app) => request(app).post('/api/public/assignment-files');

before(() => {
  ensureAssignmentDirectories();
  preExisting = new Set(listStaging());
});
beforeEach(async () => {
  cleanup();
  // The limiter is module-level, so its counter would otherwise carry across cases
  // and 429 the later tests. Reset it so each test starts with a full budget.
  await stagingRateLimitStore.resetAll();
});
after(() => { cleanup(); });
function cleanup() {
  for (const name of ourFiles()) {
    try { fs.unlinkSync(path.join(STAGING_DIR, name)); } catch { /* already gone */ }
  }
}

test('a valid PDF → 201 with a signed fileId, and no storagePath in the body', async () => {
  const res = await post(buildApp())
    .attach('file', Buffer.from('%PDF-1.4 fake pdf bytes'), { filename: 'answer.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.ok(res.body.fileId);
  assert.equal(res.body.originalName, 'answer.pdf');
  assert.equal(res.body.mimeType, 'application/pdf');
  assert.equal(res.body.sizeBytes, Buffer.from('%PDF-1.4 fake pdf bytes').length);
  assert.ok(Date.parse(res.body.expiresAt) > Date.now());

  // The client must never learn where the file lives.
  assert.equal('storagePath' in res.body, false);
  assert.equal(JSON.stringify(res.body).includes('assignment-staging'), false);
  assert.equal(JSON.stringify(res.body).includes('data/'), false);
});

test('the returned fileId verifies and carries the right metadata', async () => {
  const bytes = Buffer.from('%PDF-1.4 payload');
  const res = await post(buildApp())
    .attach('file', bytes, { filename: 'my answer.pdf', contentType: 'application/pdf' });

  const staged = verifyStagedFileToken(res.body.fileId);
  assert.equal(staged.originalName, 'my answer.pdf');
  assert.equal(staged.sizeBytes, bytes.length);
  assert.equal(staged.mimeType, 'application/pdf');
  assert.equal(staged.ext, 'pdf');
  assert.match(staged.uuid, /^[0-9a-f-]{36}$/);

  // The uuid resolves to a file that really is on disk under that exact name.
  assert.ok(fs.existsSync(path.join(STAGING_DIR, `${staged.uuid}.pdf`)));
});

test('zip and markdown are accepted on their allowed MIME types', async () => {
  const app = buildApp();
  const zip = await post(app).attach('file', Buffer.from('PK\x03\x04zip'), { filename: 'project.zip', contentType: 'application/zip' });
  assert.equal(zip.status, 201);

  const zipAlt = await post(app).attach('file', Buffer.from('PK\x03\x04zip'), { filename: 'p.zip', contentType: 'application/x-zip-compressed' });
  assert.equal(zipAlt.status, 201);

  const md = await post(app).attach('file', Buffer.from('# Notes'), { filename: 'notes.md', contentType: 'text/markdown' });
  assert.equal(md.status, 201);

  const mdPlain = await post(app).attach('file', Buffer.from('# Notes'), { filename: 'notes.md', contentType: 'text/plain' });
  assert.equal(mdPlain.status, 201);
});

test('exactly 10MB → 201; 11MB → 400 FILE_TOO_LARGE', async () => {
  const app = buildApp();
  const exact = await post(app)
    .attach('file', Buffer.alloc(10 * 1024 * 1024, 0x41), { filename: 'big.pdf', contentType: 'application/pdf' });
  assert.equal(exact.status, 201);
  assert.equal(exact.body.sizeBytes, 10 * 1024 * 1024);

  const tooBig = await post(app)
    .attach('file', Buffer.alloc(11 * 1024 * 1024, 0x41), { filename: 'huge.pdf', contentType: 'application/pdf' });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.body.code, 'FILE_TOO_LARGE');
});

/**
 * KNOWN GAP, asserted on purpose. Extension and MIME are BOTH attacker-controlled,
 * so an .exe renamed to .pdf and sent with application/pdf satisfies both signals
 * and is accepted. Magic-byte sniffing is the fix and is listed hardening (X1),
 * deliberately not done in this chunk. Asserting the accept records the gap in the
 * test suite instead of leaving it as an unexamined assumption.
 */
test('KNOWN GAP: an .exe renamed to .pdf with a forged MIME is ACCEPTED (X1 deferred)', async () => {
  const exeBytes = Buffer.from('MZ\x90\x00\x03'); // DOS/PE magic
  const res = await post(buildApp())
    .attach('file', exeBytes, { filename: 'payload.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 201, 'if this becomes 415, magic-byte sniffing landed — update this test');
});

test('mismatched ext/MIME pairs → 415 UNSUPPORTED_FILE_TYPE', async () => {
  const app = buildApp();
  const cases = [
    { filename: 'answer.pdf', contentType: 'text/plain' },
    { filename: 'answer.md', contentType: 'application/pdf' },
    { filename: 'answer.zip', contentType: 'application/pdf' },
    { filename: 'answer.exe', contentType: 'application/octet-stream' },
    { filename: 'answer.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { filename: 'noextension', contentType: 'application/pdf' },
  ];
  for (const options of cases) {
    const res = await post(app).attach('file', Buffer.from('x'), options);
    assert.equal(res.status, 415, `expected 415 for ${options.filename} / ${options.contentType}`);
    assert.equal(res.body.code, 'UNSUPPORTED_FILE_TYPE');
  }
});

test('a traversal filename is sanitized and nothing is written outside the staging dir', async () => {
  const res = await post(buildApp())
    .attach('file', Buffer.from('%PDF-1.4'), { filename: '../../../etc/passwd.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.originalName.includes('..'), false);
  assert.equal(res.body.originalName.includes('/'), false);
  assert.equal(res.body.originalName.includes('\\'), false);

  // On disk it is a uuid, and it really is inside the staging directory.
  const staged = verifyStagedFileToken(res.body.fileId);
  const written = ourFiles();
  assert.equal(written.length, 1);
  assert.equal(written[0], `${staged.uuid}.pdf`);
  assert.equal(fs.existsSync(path.resolve(STAGING_DIR, '..', '..', 'etc')), false);
});

test('unicode and over-long filenames are sanitized and capped at 128 chars', async () => {
  const app = buildApp();
  const unicode = await post(app)
    .attach('file', Buffer.from('%PDF'), { filename: 'résumé—задание✓.pdf', contentType: 'application/pdf' });
  assert.equal(unicode.status, 201);
  assert.match(unicode.body.originalName, /^[A-Za-z0-9._\- ]+$/);

  const long = await post(app)
    .attach('file', Buffer.from('%PDF'), { filename: `${'a'.repeat(300)}.pdf`, contentType: 'application/pdf' });
  assert.equal(long.status, 201);
  assert.equal(long.body.originalName.length, 128);
});

test('a request with no file → 400 NO_FILE', async () => {
  const res = await post(buildApp()).field('somethingElse', 'x');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_FILE');
});

test('a rejected upload leaves no orphan file in the staging directory', async () => {
  const app = buildApp();
  assert.equal(ourFiles().length, 0);

  await post(app).attach('file', Buffer.from('x'), { filename: 'bad.exe', contentType: 'application/octet-stream' });
  assert.deepEqual(ourFiles(), [], 'a 415 must not leave bytes behind');

  await post(app).attach('file', Buffer.alloc(11 * 1024 * 1024, 0x41), { filename: 'huge.pdf', contentType: 'application/pdf' });
  assert.deepEqual(ourFiles(), [], 'an oversized upload must not leave a partial file behind');

  await post(app).field('nope', 'x');
  assert.deepEqual(ourFiles(), [], 'a fileless request must not create anything');
});

test('the endpoint sets no cookie — the apply flow is deliberately cookie-less', async () => {
  const res = await post(buildApp())
    .attach('file', Buffer.from('%PDF'), { filename: 'a.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 201);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('the 21st upload in an hour → 429 RATE_LIMITED, and the hit is logged', async () => {
  const app = buildApp();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await post(app).attach('file', Buffer.from('%PDF'), { filename: 'a.pdf', contentType: 'application/pdf' });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.code, 'RATE_LIMITED');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.some((line) => line.includes('[assignment-upload] rate limited')), true,
    'every rate-limit hit must be logged so NAT\'d shared-IP false positives are visible');
});
