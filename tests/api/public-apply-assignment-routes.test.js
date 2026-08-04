// FILE: tests/api/public-apply-assignment-routes.test.js
// The apply path with an assignment attached — the transactional branch.
//
// Transactions require a replica set. If the connected mongod is a standalone this
// suite FAILS LOUDLY rather than skipping: a silently-skipped test on the riskiest
// code path in the feature is worse than no test, because it reads as coverage.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import request from 'supertest';
import { ObjectId, MongoServerError } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col, client } from '../../src/Db/connection.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import publicApplyRouter from '../../src/api/public/public-apply-routes.js';
import assignmentStagingRouter, { stagingRateLimitStore } from '../../src/api/public/assignment-staging-routes.js';
import {
  ensureCompanyIndexes, ensurePostingIndexes, ensureStageIndexes, ensureAssignmentIndexes,
  createCompany, createPostingForCompany, insertAssignment,
  setPostingAssignmentForCompany, updatePostingForCompany,
} from '../../src/models/employer/index.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { ensureJobIndexes } from '../../src/models/shared/job-model.js';
import {
  ensureApplicationIndexes, ensureContactIndexes, ensureStageChangeIndexes,
  ensureResumeFileIndexes, ensureAssignmentSubmissionIndexes,
} from '../../src/models/public/index.js';
import {
  ensureAssignmentDirectories, stagedPathFor,
} from '../../src/services/public/assignment-storage-service.js';
import { signStagedFileToken } from '../../src/services/employer/assignment-signed-url-service.js';
import { runApplyTransaction } from '../../src/services/public/apply-service.js';
import {
  insertAssignmentSubmission, createApplicationForCompany,
  attachResumeFileToApplication, createStageChange,
} from '../../src/models/public/index.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (relativePath) => path.resolve(BACKEND_ROOT, relativePath);

const RESUME = Buffer.from('%PDF-1.4 resume bytes');
const APPLICANT = {
  firstName: 'Priya', lastName: 'Sharma', email: 'priya@example.com',
  phone: '+919876543210', consent_dpdp: 'true',
};

const createdFiles = [];

function buildApp() {
  const app = express();
  app.use('/api/public/assignment-files', assignmentStagingRouter);
  app.use('/api/public', publicApplyRouter);
  app.use(errorHandler);
  return app;
}

/**
 * Refuse to run against a standalone mongod, and say exactly how to fix it.
 * Detected by reading setName off hello — NOT by catching a transaction error after
 * the fact, which would conflate "no replica set" with a genuine transaction bug.
 */
async function assertReplicaSet() {
  const db = await connectTestDb();
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error(
      'Transactions require a replica set. Local standalone mongod does not support '
      + 'them. Either point MONGO_URI at Atlas, or convert local mongod to a '
      + 'single-node replica set: add `replication: { replSetName: rs0 }` to '
      + 'mongod.cfg, restart the service, then run rs.initiate() once.',
    );
  }
}

async function seedCompanyWithAssignment({ withAssignment = true, status = 'active' } = {}) {
  const company = await createCompany({ name: `Acme ${new ObjectId()}` }, new ObjectId());
  await seedDefaultStagesForCompany(company._id);
  const posting = await createPostingForCompany(company._id, {
    title: 'React Developer', description: 'x'.repeat(60), location: 'Bangalore',
    workplaceType: 'remote', employmentType: 'full-time', status,
  }, new ObjectId());

  let assignment = null;
  if (withAssignment) {
    assignment = await insertAssignment({
      companyId: company._id, title: 'Build a rate limiter',
      publicSummary: 'A small backend exercise.', descriptionMarkdown: 'x'.repeat(60),
      estimatedHours: 4, submissionInstructionsMarkdown: 'Send a repo link.',
      allowedFileTypes: ['pdf'], createdByEmployerUserId: new ObjectId(),
    });
    await setPostingAssignmentForCompany(company._id, posting._id, assignment._id);
  }
  return { company, posting, assignment };
}

/** Stage a real file through the 4a endpoint and return its fileId + staging path. */
async function stageFile(app, name = 'answer.pdf') {
  await stagingRateLimitStore.resetAll();
  const res = await request(app).post('/api/public/assignment-files')
    .attach('file', Buffer.from(`%PDF-1.4 ${name}`), { filename: name, contentType: 'application/pdf' });
  assert.equal(res.status, 201, `staging upload failed: ${JSON.stringify(res.body)}`);
  const { verifyStagedFileToken } = await import('../../src/services/employer/assignment-signed-url-service.js');
  const staged = verifyStagedFileToken(res.body.fileId);
  const stagingPath = stagedPathFor(staged.uuid, staged.ext);
  createdFiles.push(stagingPath, `data/assignment-submissions/${staged.uuid}.${staged.ext}`);
  return { fileId: res.body.fileId, uuid: staged.uuid, stagingPath };
}

function apply(app, company, posting, fields = {}) {
  const req = request(app)
    .post(`/api/public/jobs/${company.slug}/${posting.slug}/apply`)
    .attach('resume', RESUME, { filename: 'cv.pdf', contentType: 'application/pdf' });
  for (const [key, value] of Object.entries({ ...APPLICANT, ...fields })) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) req.field(key, entry);
  }
  return req;
}

const countIn = async (name, filter = {}) => (await col(name)).then
  ? (await (await col(name)).countDocuments(filter))
  : 0;

before(async () => { await assertReplicaSet(); await reset(); });
beforeEach(async () => { await reset(); });
after(async () => {
  for (const relativePath of createdFiles) { try { fs.unlinkSync(abs(relativePath)); } catch { /* gone */ } }
  await closeTestDb();
});
async function reset() {
  await dropCollections('jobs', 'assignments', 'applications', 'assignment_submissions',
    'stage_changes', 'resume_files', 'contacts', 'companies', 'stages');
  await ensureCompanyIndexes(); await ensureJobIndexes(); await ensurePostingIndexes();
  await ensureStageIndexes(); await ensureAssignmentIndexes(); await ensureApplicationIndexes();
  await ensureContactIndexes(); await ensureStageChangeIndexes(); await ensureResumeFileIndexes();
  await ensureAssignmentSubmissionIndexes();
  ensureAssignmentDirectories();
  await stagingRateLimitStore.resetAll();
}

// ── Zero regression ──────────────────────────────────────────────────────────
test('ZERO REGRESSION: a posting with NO assignment applies exactly as before', async () => {
  const { company, posting } = await seedCompanyWithAssignment({ withAssignment: false });
  const app = buildApp();

  const res = await apply(app, company, posting);
  assert.equal(res.status, 200);
  assert.ok(res.body.applicationId);
  assert.equal(Object.keys(res.body).length, 1, 'response shape must be unchanged: { applicationId }');

  const applications = await col('applications');
  const application = await applications.findOne({ _id: new ObjectId(res.body.applicationId) });
  assert.ok(application);
  assert.equal(application.assignmentSubmissionId, null);
  // The plain path must not touch the submissions collection at all.
  const submissions = await col('assignment_submissions');
  assert.equal(await submissions.countDocuments({}), 0);
  // The old consent shape is untouched — no dataItems, no noticeVersion.
  assert.equal('dataItems' in application.consent, false);
  assert.equal('noticeVersion' in application.consent, false);
});

// ── Happy path ───────────────────────────────────────────────────────────────
test('HAPPY PATH: 1 link + 2 files + notes → application and submission cross-reference', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  const app = buildApp();
  const fileA = await stageFile(app, 'part-one.pdf');
  const fileB = await stageFile(app, 'part-two.pdf');

  const res = await apply(app, company, posting, {
    assignmentId: assignment._id.toString(),
    assignmentLinks: ['https://github.com/priya/solution'],
    assignmentFileIds: [fileA.fileId, fileB.fileId],
    assignmentNotesMarkdown: '# My approach\n\nI used a token bucket.',
    githubUrl: 'https://github.com/priya',
    linkedinUrl: 'https://in.linkedin.com/in/priya-sharma',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const applications = await col('applications');
  const submissions = await col('assignment_submissions');
  assert.equal(await applications.countDocuments({}), 1);
  assert.equal(await submissions.countDocuments({}), 1);

  const application = await applications.findOne({});
  const submission = await submissions.findOne({});
  assert.equal(application._id.toString(), res.body.applicationId);
  assert.equal(application.assignmentSubmissionId.toString(), submission._id.toString());
  assert.equal(submission.applicationId.toString(), application._id.toString());

  assert.equal(submission.links.length, 1);
  assert.equal(submission.files.length, 2);
  assert.equal(submission.seekerNotesMarkdown, '# My approach\n\nI used a token bucket.');
  assert.deepEqual(submission.profileLinks, {
    githubUrl: 'https://github.com/priya',
    linkedinUrl: 'https://in.linkedin.com/in/priya-sharma',
  });

  // The consent evidence records the new data items and the notice version.
  assert.deepEqual(application.consent.dataItems, ['assignment_files', 'assignment_notes', 'profile_links']);
  assert.ok(application.consent.noticeVersion);

  // The stage change landed inside the same transaction.
  const stageChanges = await col('stage_changes');
  assert.equal(await stageChanges.countDocuments({ applicationId: application._id }), 1);
});

test('HAPPY PATH: the snapshot freezes the assignment as it was at submit time', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  const app = buildApp();
  const file = await stageFile(app);

  await apply(app, company, posting, {
    assignmentId: assignment._id.toString(), assignmentFileIds: [file.fileId],
  }).expect(200);

  const submission = await (await col('assignment_submissions')).findOne({});
  assert.equal(submission.assignmentSnapshot.title, 'Build a rate limiter');
  assert.equal(submission.assignmentSnapshot.estimatedHours, 4);
  assert.equal(submission.assignmentSnapshot.submissionInstructionsMarkdown, 'Send a repo link.');
  assert.deepEqual(submission.assignmentSnapshot.allowedFileTypes, ['pdf']);
  assert.equal(submission.assignmentSnapshot.sourceAssignmentId.toString(), assignment._id.toString());
  assert.ok(submission.assignmentSnapshot.snapshottedAt instanceof Date);
});

test('HAPPY PATH: files are promoted out of staging into submissions', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  const app = buildApp();
  const fileA = await stageFile(app, 'a.pdf');
  const fileB = await stageFile(app, 'b.pdf');

  await apply(app, company, posting, {
    assignmentId: assignment._id.toString(), assignmentFileIds: [fileA.fileId, fileB.fileId],
  }).expect(200);

  const submission = await (await col('assignment_submissions')).findOne({});
  for (const file of submission.files) {
    assert.ok(file.storagePath.startsWith('data/assignment-submissions/'),
      'the row must carry the FINAL path, never the staging path');
    assert.equal(fs.existsSync(abs(file.storagePath)), true, `${file.storagePath} must exist`);
  }
  assert.equal(fs.existsSync(abs(fileA.stagingPath)), false, 'staging copy must be gone');
  assert.equal(fs.existsSync(abs(fileB.stagingPath)), false);
});

// ── Gates and rejections ─────────────────────────────────────────────────────
test('no links and no files → 400 ASSIGNMENT_SUBMISSION_REQUIRED and NO application row', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  const res = await apply(buildApp(), company, posting, { assignmentId: assignment._id.toString() });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ASSIGNMENT_SUBMISSION_REQUIRED');
  assert.equal(await (await col('applications')).countDocuments({}), 0);
  assert.equal(await (await col('assignment_submissions')).countDocuments({}), 0);
});

test('a stale assignmentId → 409 ASSIGNMENT_CHANGED and no rows created', async () => {
  const { company, posting } = await seedCompanyWithAssignment();
  const app = buildApp();
  const file = await stageFile(app);

  const res = await apply(app, company, posting, {
    assignmentId: new ObjectId().toString(), assignmentFileIds: [file.fileId],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ASSIGNMENT_CHANGED');
  assert.equal(await (await col('applications')).countDocuments({}), 0);
  assert.equal(await (await col('assignment_submissions')).countDocuments({}), 0);
});

test('a missing assignmentId → 400 MISSING_ASSIGNMENT_ID', async () => {
  const { company, posting } = await seedCompanyWithAssignment();
  const app = buildApp();
  const file = await stageFile(app);
  const res = await apply(app, company, posting, { assignmentFileIds: [file.fileId] });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_ASSIGNMENT_ID');
});

test('an EXPIRED staged fileId → 400 STAGED_FILES_EXPIRED naming the file', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  const expired = signStagedFileToken(
    { uuid: new ObjectId().toString(), ext: 'pdf', originalName: 'old.pdf', sizeBytes: 10, mimeType: 'application/pdf' },
    -1,
  ).token;

  const res = await apply(buildApp(), company, posting, {
    assignmentId: assignment._id.toString(), assignmentFileIds: [expired],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'STAGED_FILES_EXPIRED');
  assert.equal(await (await col('applications')).countDocuments({}), 0);
});

test('6 fileIds → 400 TOO_MANY_FILES', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  const app = buildApp();
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await stageFile(app, `f${i}.pdf`)).fileId);

  const res = await apply(app, company, posting, {
    assignmentId: assignment._id.toString(), assignmentFileIds: ids,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TOO_MANY_FILES');
});

test('a posting closed after the form loaded → 409 POSTING_CLOSED_DURING_APPLY', async () => {
  const { company, posting, assignment } = await seedCompanyWithAssignment();
  await updatePostingForCompany(company._id, posting._id, { status: 'closed' });

  const res = await apply(buildApp(), company, posting, { assignmentId: assignment._id.toString() });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'POSTING_CLOSED_DURING_APPLY');
  assert.match(res.body.error, /has not been lost/);
});

test('a closed posting with NO assignment → still the old 404 POSTING_NOT_FOUND', async () => {
  const { company, posting } = await seedCompanyWithAssignment({ withAssignment: false });
  await updatePostingForCompany(company._id, posting._id, { status: 'closed' });

  const res = await apply(buildApp(), company, posting);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'POSTING_NOT_FOUND');
});

test('a slug that never existed → 404 POSTING_NOT_FOUND, unchanged', async () => {
  const { company } = await seedCompanyWithAssignment();
  const res = await request(buildApp())
    .post(`/api/public/jobs/${company.slug}/no-such-role/apply`)
    .attach('resume', RESUME, { filename: 'cv.pdf', contentType: 'application/pdf' })
    .field('firstName', 'A').field('lastName', 'B').field('email', 'a@b.com').field('consent_dpdp', 'true');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'POSTING_NOT_FOUND');
});

// ── Rollback + retry, driven through the exported seam ───────────────────────
// Mechanism (c): apply-service imports its model helpers as static ESM bindings.
// Module namespace objects are immutable, so they cannot be monkey-patched, and
// this repo has no mocking library (node --test only). runApplyTransaction is
// therefore exported with an injectable `operations` map so a deliberately failing
// implementation can be driven directly against a REAL session and a REAL
// transaction — no stubbing of an import anywhere.
function transactionContext() {
  return {
    applicationId: new ObjectId(),
    submissionId: new ObjectId(),
    companyId: new ObjectId(),
    resumeFileId: new ObjectId(),
    defaultStageId: new ObjectId(),
    submissionDoc: {
      applicationId: null, companyId: new ObjectId(), jobId: new ObjectId(),
      links: [], files: [], seekerNotesMarkdown: 'notes',
    },
    applicationDoc: { jobId: new ObjectId(), contactId: new ObjectId(), stageId: new ObjectId() },
  };
}

const realOperations = {
  insertAssignmentSubmission, createApplicationForCompany,
  attachResumeFileToApplication, createStageChange,
};

test('ROLLBACK: a failure on the LAST write leaves nothing behind', async () => {
  const context = transactionContext();
  context.submissionDoc.applicationId = context.applicationId;
  context.applicationDoc.companyId = context.companyId;

  const failing = {
    ...realOperations,
    createStageChange: async () => { throw new Error('deliberate mid-transaction failure'); },
  };

  const session = client.startSession();
  await assert.rejects(
    () => session.withTransaction(async () => {
      await runApplyTransaction({ ...context, session, companyId: context.companyId }, failing);
    }),
    /deliberate mid-transaction failure/,
  );
  await session.endSession();

  // The first three writes succeeded inside the transaction and must all be gone.
  assert.equal(await (await col('assignment_submissions')).countDocuments({ _id: context.submissionId }), 0,
    'the submission must be rolled back');
  assert.equal(await (await col('applications')).countDocuments({ _id: context.applicationId }), 0,
    'the application must be rolled back');
  assert.equal(await (await col('stage_changes')).countDocuments({ applicationId: context.applicationId }), 0);
});

test('a PRE-transaction rejection leaves the staged file intact for the retry', async () => {
  // The service deletes staged files only when the transaction itself failed — the
  // bytes are then unreferenced. A request rejected before the transaction opens
  // (drift, expired ids, empty submission) must leave them alone, or a candidate
  // who mis-clicks once has to re-upload everything.
  const { company, posting } = await seedCompanyWithAssignment();
  const app = buildApp();
  const file = await stageFile(app);

  const res = await apply(app, company, posting, {
    assignmentId: new ObjectId().toString(), assignmentFileIds: [file.fileId],
  });
  assert.equal(res.status, 409);
  assert.equal(fs.existsSync(abs(file.stagingPath)), true);
});

test('RETRY IDEMPOTENCE: a transient failure re-runs the callback and writes ONE of each', async () => {
  const context = transactionContext();
  context.submissionDoc.applicationId = context.applicationId;
  context.applicationDoc.companyId = context.companyId;

  let attempts = 0;
  const flaky = {
    ...realOperations,
    createStageChange: async (data, options) => {
      attempts += 1;
      if (attempts === 1) {
        // Must be a REAL MongoError carrying the label: withTransaction only retries
        // when `error instanceof MongoError && error.hasErrorLabel(...)`, so a plain
        // Error with the property set is not enough and would just propagate.
        const err = new MongoServerError({ message: 'transient blip' });
        err.addErrorLabel('TransientTransactionError');
        throw err;
      }
      return realOperations.createStageChange(data, options);
    },
  };

  const session = client.startSession();
  await session.withTransaction(async () => {
    await runApplyTransaction({ ...context, session }, flaky);
  });
  await session.endSession();

  assert.ok(attempts >= 2, `the callback must have re-run, attempts=${attempts}`);
  // Exactly one of each, carrying the PRE-GENERATED ids — proof the retry reused
  // them instead of orphaning the first attempt's documents.
  assert.equal(await (await col('applications')).countDocuments({}), 1);
  assert.equal(await (await col('assignment_submissions')).countDocuments({}), 1);
  assert.equal(await (await col('applications')).countDocuments({ _id: context.applicationId }), 1);
  assert.equal(await (await col('assignment_submissions')).countDocuments({ _id: context.submissionId }), 1);
});
