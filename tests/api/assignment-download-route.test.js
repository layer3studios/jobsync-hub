// FILE: tests/api/assignment-download-route.test.js
// No DB — the download route resolves everything from the signed token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import assignmentDownloadRouter from '../../src/api/public/assignment-download-route.js';
import {
  ensureAssignmentDirectories, writeStagedFile, promoteStagedFile, deleteSubmissionFile,
} from '../../src/services/public/assignment-storage-service.js';
import {
  signAssignmentFileToken,
} from '../../src/services/employer/assignment-signed-url-service.js';

const BACKEND_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '../..');
const PDF_BYTES = Buffer.from('%PDF-1.4 the candidate answer bytes');

const created = [];
let pdfPath;
let zipPath;

function buildApp() {
  const app = express();
  app.use('/api/public/assignment-download', assignmentDownloadRouter);
  app.use(errorHandler);
  return app;
}

const get = (token, extra = '') => request(buildApp())
  .get(`/api/public/assignment-download?token=${encodeURIComponent(token)}${extra}`);

before(() => {
  ensureAssignmentDirectories();
  const stagedPdf = writeStagedFile(PDF_BYTES, 'pdf');
  pdfPath = promoteStagedFile(stagedPdf.storagePath);
  const stagedZip = writeStagedFile(Buffer.from('PK\x03\x04 archive'), 'zip');
  zipPath = promoteStagedFile(stagedZip.storagePath);
  created.push(pdfPath, zipPath);
});
after(() => { for (const relativePath of created) deleteSubmissionFile(relativePath); });

test('a valid token → 200 with the exact file bytes and the right Content-Type', async () => {
  const res = await get(signAssignmentFileToken(pdfPath));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(Number(res.headers['content-length']), PDF_BYTES.length);
  assert.equal(Buffer.compare(res.body, PDF_BYTES), 0, 'body must match the file byte for byte');
  assert.equal(res.headers['cache-control'], 'private, no-store');
});

test('Content-Disposition is attachment, never inline', async () => {
  const res = await get(signAssignmentFileToken(pdfPath));
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.equal(res.headers['content-disposition'].includes('inline'), false);
});

test('the download filename is taken from the query and sanitized', async () => {
  const res = await get(signAssignmentFileToken(pdfPath), `&filename=${encodeURIComponent('../../etc/passwd"; evil.pdf')}`);
  assert.equal(res.status, 200);
  const disposition = res.headers['content-disposition'];
  // This is a DISPLAY name, never a path — the file served is fixed by the token, so
  // what matters is that it cannot break the header or imply a directory. Dots are
  // legal in filenames and are left alone.
  assert.equal(disposition.includes('/'), false);
  assert.equal(disposition.includes('\\'), false);
  // The quote that would break out of the header value is stripped.
  assert.equal(disposition.split('"').length, 3);
  assert.match(disposition, /^attachment; filename="[\w.\- ]*"$/);
});

test('a zip is served as application/zip and still as an attachment', async () => {
  const res = await get(signAssignmentFileToken(zipPath));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /^attachment;/);
});

test('no token → 400 MISSING_TOKEN', async () => {
  const res = await request(buildApp()).get('/api/public/assignment-download');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_TOKEN');
});

test('a tampered token → 401 INVALID_TOKEN', async () => {
  const token = signAssignmentFileToken(pdfPath);
  const res = await get(`${token}xyz`);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_TOKEN');
});

test('an expired token → 401 INVALID_TOKEN', async () => {
  const res = await get(signAssignmentFileToken(pdfPath, -1));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_TOKEN');
});

test('a validly-signed token whose path escapes the dirs → 403 FORBIDDEN_PATH', async () => {
  // Signed with the real secret, so the signature check passes — only the path
  // containment guard stands between this and an arbitrary file read.
  for (const escape of ['../../../etc/passwd', 'data/resumes/someone-else.pdf', '/etc/passwd', 'package.json']) {
    const res = await get(signAssignmentFileToken(escape));
    assert.equal(res.status, 403, `expected 403 for ${escape}`);
    assert.equal(res.body.code, 'FORBIDDEN_PATH');
  }
});

test('a path that only looks like the staging dir is still refused', async () => {
  const res = await get(signAssignmentFileToken('data/assignment-staging-evil/x.pdf'));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN_PATH');
});

test('a traversal that resolves back out of the dir is refused', async () => {
  const res = await get(signAssignmentFileToken('data/assignment-submissions/../../package.json'));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN_PATH');
});

test('a valid token whose file is gone from disk → 404 FILE_MISSING', async () => {
  const staged = writeStagedFile(Buffer.from('temporary'), 'pdf');
  const promoted = promoteStagedFile(staged.storagePath);
  const token = signAssignmentFileToken(promoted);
  assert.equal((await get(token)).status, 200);

  fs.unlinkSync(path.resolve(BACKEND_ROOT, promoted));
  const res = await get(token);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'FILE_MISSING');
});
