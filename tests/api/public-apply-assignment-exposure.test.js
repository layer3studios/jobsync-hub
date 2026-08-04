// FILE: tests/api/public-apply-assignment-exposure.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import publicApplyRouter from '../../src/api/public/public-apply-routes.js';
import { ensureContactIndexes } from '../../src/models/public/contact-model.js';
import { ensureAssignmentIndexes, insertAssignment, archiveAssignmentForCompany } from '../../src/models/employer/assignment-model.js';

const COMPANY_ID = new ObjectId();

// The exact task text — asserted whole, to catch any future truncation.
const FULL_DESCRIPTION = [
  '# Build a rate limiter', '',
  'Implement a token-bucket limiter with the following properties:', '',
  '- 100 requests per minute per key',
  '- burst capacity of 20',
  '- a `retryAfter` hint on rejection', '',
  '```js',
  'const limiter = createLimiter({ capacity: 20, refillPerMinute: 100 });',
  '```', '',
  'Explain your eviction strategy in the README.',
].join('\n');

function buildApp() {
  const app = express();
  app.use('/api/public', publicApplyRouter);
  app.use(errorHandler);
  return app;
}

let slugSeq = 0;
async function seedPosting({ assignmentId = null, slug, title = 'React Dev' } = {}) {
  slugSeq += 1;
  const postingSlug = slug ?? `role-${slugSeq}`;
  const _id = new ObjectId();
  await (await col('jobs')).insertOne({
    _id, companyId: COMPANY_ID, slug: postingSlug, source: 'native', status: 'active',
    title, description: 'd', descriptionPlain: 'd', location: 'Bengaluru',
    workplaceType: 'remote', employmentType: 'full-time', salaryCurrency: 'INR',
    assignmentId, createdAt: new Date(), updatedAt: new Date(),
  });
  return { _id, slug: postingSlug };
}

function seedAssignment(overrides = {}) {
  return insertAssignment({
    companyId: COMPANY_ID, title: 'Build a rate limiter',
    publicSummary: 'A focused backend exercise, about half a day.',
    descriptionMarkdown: FULL_DESCRIPTION, estimatedHours: 4,
    submissionInstructionsMarkdown: 'Send us a public repo link.',
    allowedFileTypes: ['pdf', 'zip'], createdByEmployerUserId: new ObjectId(),
    ...overrides,
  });
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('companies', 'jobs', 'stages', 'assignments', 'contacts', 'applications');
  await ensureContactIndexes(); await ensureAssignmentIndexes();
  await (await col('companies')).insertOne({
    _id: COMPANY_ID, slug: 'acme', name: 'Acme', website: null, logoUrl: null,
  });
}

// ── Detail ───────────────────────────────────────────────────────────────────
test('DETAIL: a posting with an assignment returns all seven public fields', async () => {
  const assignment = await seedAssignment();
  const posting = await seedPosting({ assignmentId: assignment._id, slug: 'react-dev' });

  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['assignment', 'company', 'job']);
  // Seven: the candidate needs the task's title to know what they are answering.
  assert.deepEqual(Object.keys(res.body.assignment).sort(), [
    'allowedFileTypes', 'descriptionMarkdown', 'estimatedHours', 'id',
    'publicSummary', 'submissionInstructionsMarkdown', 'title',
  ]);
  assert.equal(res.body.assignment.id, assignment._id.toString());
  assert.equal(res.body.assignment.title, 'Build a rate limiter');
  assert.equal(res.body.assignment.publicSummary, 'A focused backend exercise, about half a day.');
  assert.equal(res.body.assignment.estimatedHours, 4);
  assert.deepEqual(res.body.assignment.allowedFileTypes, ['pdf', 'zip']);
  assert.equal(res.body.assignment.submissionInstructionsMarkdown, 'Send us a public repo link.');
  assert.equal(res.body.job.id, posting._id.toString());
});

test('DETAIL: descriptionMarkdown is returned IN FULL — no gate, no truncation', async () => {
  const assignment = await seedAssignment();
  await seedPosting({ assignmentId: assignment._id, slug: 'react-dev' });

  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  // The whole string, byte for byte. The apply page is public; progressive
  // disclosure is the frontend's choice, never an API-side gate.
  assert.equal(res.body.assignment.descriptionMarkdown, FULL_DESCRIPTION);
  assert.equal(res.body.assignment.descriptionMarkdown.length, FULL_DESCRIPTION.length);
  assert.ok(res.body.assignment.descriptionMarkdown.includes('Explain your eviction strategy'));
  assert.equal(res.body.assignment.descriptionMarkdown.includes('…'), false);
  assert.equal(res.body.assignment.descriptionMarkdown.includes('...'), false);
});

test('DETAIL: employer-side fields are ABSENT from the public assignment', async () => {
  const assignment = await seedAssignment();
  await seedPosting({ assignmentId: assignment._id, slug: 'react-dev' });

  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  for (const field of ['companyId', 'createdByEmployerUserId', 'archivedAt', 'createdAt', 'updatedAt', '_id']) {
    assert.equal(field in res.body.assignment, false, `${field} must not be exposed`);
  }
  const serialized = JSON.stringify(res.body.assignment);
  assert.equal(serialized.includes(COMPANY_ID.toString()), false);
});

test('DETAIL: a posting with NO assignment returns assignment: null and an unchanged job', async () => {
  await seedPosting({ slug: 'react-dev' });
  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  assert.equal(res.status, 200);
  assert.equal(res.body.assignment, null);
  // `job` is still exactly toPublicPosting — every pre-chunk key present.
  for (const key of ['id', 'slug', 'title', 'description', 'descriptionPlain', 'location',
    'workplaceType', 'employmentType', 'salaryMin', 'salaryMax', 'salaryCurrency',
    'status', 'assignmentId', 'postedAt', 'createdAt', 'updatedAt']) {
    assert.ok(key in res.body.job, `job.${key} missing`);
  }
  assert.equal(res.body.job.assignmentId, null);
});

test('DETAIL: an ARCHIVED assignment still renders in full', async () => {
  const assignment = await seedAssignment();
  await seedPosting({ assignmentId: assignment._id, slug: 'react-dev' });
  await archiveAssignmentForCompany(COMPANY_ID, assignment._id);

  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  assert.equal(res.status, 200);
  assert.ok(res.body.assignment, 'archiving blocks NEW attachment only — this one is already attached');
  assert.equal(res.body.assignment.descriptionMarkdown, FULL_DESCRIPTION);
  assert.equal('archivedAt' in res.body.assignment, false);
});

test('DETAIL: a DANGLING assignmentId → assignment null, 200, warned not thrown', async () => {
  const assignment = await seedAssignment();
  await seedPosting({ assignmentId: assignment._id, slug: 'react-dev' });
  await (await col('assignments')).deleteOne({ _id: assignment._id });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let res;
  try {
    res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 200, 'a data bug must never take down a public page');
  assert.equal(res.body.assignment, null);
  assert.ok(res.body.job, 'the job itself still renders');
  assert.ok(warnings.some((line) => line.includes('references missing assignment')));
});

test('DETAIL: a cross-tenant assignmentId resolves to null, never another tenant\'s task', async () => {
  const otherCompanyId = new ObjectId();
  const foreign = await insertAssignment({
    companyId: otherCompanyId, title: 'Secret task', publicSummary: 'Not yours at all.',
    descriptionMarkdown: 'x'.repeat(60), estimatedHours: 2,
    submissionInstructionsMarkdown: '', allowedFileTypes: [], createdByEmployerUserId: new ObjectId(),
  });
  await seedPosting({ assignmentId: foreign._id, slug: 'react-dev' });

  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try { res = await request(buildApp()).get('/api/public/jobs/acme/react-dev'); } finally { console.warn = originalWarn; }
  assert.equal(res.status, 200);
  assert.equal(res.body.assignment, null);
  assert.equal(JSON.stringify(res.body).includes('Secret task'), false);
});

// ── List ─────────────────────────────────────────────────────────────────────
test('LIST: 3 postings, 2 with assignments → badges on those two, null on the third', async () => {
  const first = await seedAssignment();
  const second = await seedAssignment({ estimatedHours: 2, allowedFileTypes: ['md'] });
  await seedPosting({ assignmentId: first._id, slug: 'a', title: 'A' });
  await seedPosting({ assignmentId: second._id, slug: 'b', title: 'B' });
  await seedPosting({ slug: 'c', title: 'C' });

  const res = await request(buildApp()).get('/api/public/companies/acme');
  assert.equal(res.status, 200);
  assert.equal(res.body.jobs.length, 3);
  const bySlug = new Map(res.body.jobs.map((job) => [job.slug, job]));

  assert.deepEqual(bySlug.get('a').assignment, { estimatedHours: 4, allowedFileTypes: ['pdf', 'zip'] });
  assert.deepEqual(bySlug.get('b').assignment, { estimatedHours: 2, allowedFileTypes: ['md'] });
  assert.equal(bySlug.get('c').assignment, null);
});

test('LIST: the summary carries badge data only — no task text', async () => {
  const assignment = await seedAssignment();
  await seedPosting({ assignmentId: assignment._id, slug: 'a' });

  const res = await request(buildApp()).get('/api/public/companies/acme');
  const [job] = res.body.jobs;
  assert.deepEqual(Object.keys(job.assignment).sort(), ['allowedFileTypes', 'estimatedHours']);
  assert.equal('descriptionMarkdown' in job.assignment, false);
  assert.equal('publicSummary' in job.assignment, false);
  assert.equal('submissionInstructionsMarkdown' in job.assignment, false);
  assert.equal(JSON.stringify(res.body).includes('token-bucket'), false);
});

test('LIST: a company with no assignment-bearing postings keeps every pre-chunk field', async () => {
  await seedPosting({ slug: 'a', title: 'A' });
  await seedPosting({ slug: 'b', title: 'B' });

  const res = await request(buildApp()).get('/api/public/companies/acme');
  assert.deepEqual(Object.keys(res.body).sort(), ['company', 'jobs']);
  for (const job of res.body.jobs) {
    // The five original keys, unchanged, plus the always-present assignment key.
    for (const key of ['id', 'slug', 'title', 'location', 'employmentType']) {
      assert.ok(key in job, `job.${key} missing`);
    }
    assert.deepEqual(Object.keys(job).sort(), ['assignment', 'employmentType', 'id', 'location', 'slug', 'title']);
    assert.equal(job.assignment, null);
  }
});

// ── N+1 ──────────────────────────────────────────────────────────────────────
/**
 * Count reads against the assignments collection by wrapping db.collection —
 * col() calls it fresh on every access, so this catches every query the request
 * makes, wherever it originates.
 */
async function countAssignmentQueries(run) {
  const db = await connectTestDb();
  const originalCollection = db.collection.bind(db);
  let queries = 0;
  db.collection = (name, ...rest) => {
    const collection = originalCollection(name, ...rest);
    if (name !== 'assignments') return collection;
    const originalFind = collection.find.bind(collection);
    const originalFindOne = collection.findOne.bind(collection);
    collection.find = (...args) => { queries += 1; return originalFind(...args); };
    collection.findOne = (...args) => { queries += 1; return originalFindOne(...args); };
    return collection;
  };
  try {
    const result = await run();
    return { queries, result };
  } finally {
    db.collection = originalCollection;
  }
}

test('N+1: 5 postings sharing ONE assignment issue exactly ONE assignments query', async () => {
  const assignment = await seedAssignment();
  for (let i = 0; i < 5; i += 1) await seedPosting({ assignmentId: assignment._id, slug: `role-${i}` });

  const { queries, result } = await countAssignmentQueries(
    () => request(buildApp()).get('/api/public/companies/acme'),
  );
  assert.equal(result.body.jobs.length, 5);
  assert.equal(queries, 1, `expected exactly 1 assignments query for 5 postings, got ${queries}`);
  for (const job of result.body.jobs) assert.equal(job.assignment.estimatedHours, 4);
});

test('N+1: 5 postings with FIVE distinct assignments still issue ONE query', async () => {
  for (let i = 0; i < 5; i += 1) {
    const assignment = await seedAssignment({ estimatedHours: (i % 8) + 1 });
    await seedPosting({ assignmentId: assignment._id, slug: `role-${i}` });
  }
  const { queries, result } = await countAssignmentQueries(
    () => request(buildApp()).get('/api/public/companies/acme'),
  );
  assert.equal(result.body.jobs.length, 5);
  assert.equal(queries, 1, `a per-job lookup loop would be 5; got ${queries}`);
});

test('N+1: a company with zero assignments issues ZERO assignments queries', async () => {
  await seedPosting({ slug: 'a' });
  await seedPosting({ slug: 'b' });

  const { queries } = await countAssignmentQueries(
    () => request(buildApp()).get('/api/public/companies/acme'),
  );
  assert.equal(queries, 0, 'the batch read must short-circuit on an empty id list');
});
