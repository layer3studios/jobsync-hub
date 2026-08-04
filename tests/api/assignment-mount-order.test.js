// FILE: tests/api/assignment-mount-order.test.js
// MOUNT ORDER REGRESSION GUARD.
//
// server.js mounts several specific /api/public/* routers ABOVE the catch-all
// `app.use('/api/public', publicApplyRouter)`. Express matches mounts in
// registration order, so if either assignment router is ever moved below that line,
// the apply router claims the path first and every assignment request becomes a 404
// from its 404 handler — with no error, no failing unit test, and no clue in the
// logs. This suite builds an app in the SAME order as server.js and proves our
// routes are still reachable.
//
// If someone moves the mounts below publicApplyRouter, THESE TESTS FAIL. That is
// the entire point of the file — do not "fix" a failure here by relaxing it.
import './../_helpers/test-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import request from 'supertest';

import { closeTestDb } from '../_helpers/test-db.js';
import { errorHandler, notFound } from '../../src/middleware/error-handler-middleware.js';
import assignmentStagingRouter, { stagingRateLimitStore } from '../../src/api/public/assignment-staging-routes.js';
import assignmentDownloadRouter from '../../src/api/public/assignment-download-route.js';
import resumeDownloadRouter from '../../src/api/public/resume-download-route.js';
import publicApplyRouter from '../../src/api/public/public-apply-routes.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_SOURCE = fs.readFileSync(path.join(BACKEND_ROOT, 'src', 'server.js'), 'utf8');

after(async () => { await closeTestDb(); });

/** Mounted in the SAME relative order as src/server.js. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public/resume-download', resumeDownloadRouter);
  app.use('/api/public/assignment-files', assignmentStagingRouter);
  app.use('/api/public/assignment-download', assignmentDownloadRouter);
  app.use('/api/public', publicApplyRouter); // the catch-all — must stay last
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

test('GET /api/public/assignment-download reaches OUR route, not the apply catch-all', async () => {
  const res = await request(buildApp()).get('/api/public/assignment-download?token=bad');
  // 401 proves our handler ran and rejected the token. A 404 would mean the apply
  // router swallowed the path.
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_TOKEN');
  assert.notEqual(res.status, 404);
});

test('POST /api/public/assignment-files reaches OUR route, not the apply catch-all', async () => {
  await stagingRateLimitStore.resetAll();
  const res = await request(buildApp()).post('/api/public/assignment-files').field('nothing', 'x');
  // 400 NO_FILE proves multer + our handler ran.
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_FILE');
  assert.notEqual(res.status, 404);
});

test('an unrelated /api/public path still falls through to the apply router', async () => {
  // Proves the ordering does not shadow the catch-all either — the apply router
  // still owns everything we did not explicitly claim.
  const res = await request(buildApp()).get('/api/public/companies/no-such-company');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'COMPANY_NOT_FOUND'); // from the apply router, not notFound()
});

/**
 * Reads server.js as text. The runtime tests above prove the ORDER works in an app
 * we assemble ourselves; this one proves server.js itself has the same order, which
 * no amount of supertest against a hand-built app can show.
 */
test('src/server.js mounts both assignment routers ABOVE the apply catch-all', () => {
  const catchAll = SERVER_SOURCE.indexOf("app.use('/api/public', publicApplyRouter)");
  const staging = SERVER_SOURCE.indexOf("app.use('/api/public/assignment-files'");
  const download = SERVER_SOURCE.indexOf("app.use('/api/public/assignment-download'");

  assert.ok(catchAll > 0, 'the apply catch-all mount must exist in server.js');
  assert.ok(staging > 0, 'the staging mount must exist in server.js');
  assert.ok(download > 0, 'the download mount must exist in server.js');
  assert.ok(staging < catchAll, 'assignment-files must be mounted BEFORE the apply catch-all');
  assert.ok(download < catchAll, 'assignment-download must be mounted BEFORE the apply catch-all');
});
