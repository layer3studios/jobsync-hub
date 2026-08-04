// FILE: tests/api/employer-assignments-routes.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { EMPLOYER_JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireEmployer } from '../../src/middleware/require-employer-middleware.js';
import { requireEmployerCompany } from '../../src/middleware/require-employer-company-middleware.js';
import employerAssignmentsRouter from '../../src/api/employer/employer-assignments-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensureCompanyMemberIndexes,
  ensureAssignmentIndexes, ensurePostingIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser,
  insertCompanyMember, insertAssignment,
} from '../../src/models/employer/index.js';
import { ensureJobIndexes } from '../../src/models/shared/job-model.js';

const VALID_BODY = {
  title: 'Build a rate limiter',
  publicSummary: 'A small backend exercise, about half a day.',
  descriptionMarkdown: `# Task\n\n${'x'.repeat(60)}`,
  estimatedHours: 4,
  submissionInstructionsMarkdown: 'Send us a repo link.',
  allowedFileTypes: ['pdf'],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/assignments', requireEmployer, requireEmployerCompany, employerAssignmentsRouter);
  app.use(errorHandler);
  return app;
}

async function onboardedCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return { cookie: `jm_employer_token=${token}`, company };
}

let roleSeq = 0;
async function addRoleCookie(companyId, role, extra = {}) {
  roleSeq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `gr-${role}-${roleSeq}`, email: `r${role}${roleSeq}@acme.com`, name: role, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: false, ...extra });
  return `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;
}

/** Attach a native posting to an assignment, the way Chunk 3 eventually will. */
async function attachNativeJob(companyId, assignmentId, title = 'Backend Engineer') {
  const jobs = await col('jobs');
  await jobs.insertOne({
    source: 'native', companyId, assignmentId: new ObjectId(assignmentId),
    title, slug: title.toLowerCase().replace(/\s+/g, '-'), status: 'active',
  });
}

const create = (app, cookie, body = VALID_BODY) => request(app).post('/api/employer/assignments').set('Cookie', cookie).send(body);

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignments', 'jobs', 'companies', 'company_members', 'employer_users');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
  await ensureJobIndexes(); await ensurePostingIndexes(); await ensureAssignmentIndexes();
}

test('POST creates an assignment → 201 with the public shape, no companyId', async () => {
  const { cookie } = await onboardedCookie('a');
  const res = await create(buildApp(), cookie);
  assert.equal(res.status, 201);
  const { assignment } = res.body;
  assert.equal(assignment.title, 'Build a rate limiter');
  assert.equal(assignment.estimatedHours, 4);
  assert.deepEqual(assignment.allowedFileTypes, ['pdf']);
  assert.equal(assignment.archivedAt, null);
  for (const field of ['id', 'publicSummary', 'descriptionMarkdown',
    'submissionInstructionsMarkdown', 'createdByEmployerUserId', 'createdAt', 'updatedAt']) {
    assert.ok(field in assignment, `missing field ${field}`);
  }
  assert.equal('companyId' in assignment, false); // owner field never exposed
  assert.equal('_id' in assignment, false);
});

test('POST with no cookie → 401', async () => {
  const res = await request(buildApp()).post('/api/employer/assignments').send(VALID_BODY);
  assert.equal(res.status, 401);
});

test('POST with an invalid body → 400 with the validator code', async () => {
  const { cookie } = await onboardedCookie('inv');
  const app = buildApp();
  const short = await create(app, cookie, { ...VALID_BODY, title: 'x' });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'INVALID_TITLE');
  const hours = await create(app, cookie, { ...VALID_BODY, estimatedHours: 2.5 });
  assert.equal(hours.body.code, 'INVALID_ESTIMATED_HOURS');
});

test('GET list returns only the caller company\'s assignments', async () => {
  const { cookie } = await onboardedCookie('b');
  const other = await onboardedCookie('b2');
  const app = buildApp();
  await create(app, cookie);
  await create(app, other.cookie, { ...VALID_BODY, title: 'Other tenant task' });

  const res = await request(app).get('/api/employer/assignments').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.assignments.length, 1);
  assert.equal(res.body.assignments[0].title, 'Build a rate limiter');
  assert.equal(res.body.assignments.some((a) => a.title === 'Other tenant task'), false);
});

test('GET /:id cross-tenant → 404 ASSIGNMENT_NOT_FOUND, never 403', async () => {
  const { cookie } = await onboardedCookie('c');
  const other = await onboardedCookie('c2');
  const app = buildApp();
  const created = await create(app, cookie);
  const id = created.body.assignment.id;

  const mine = await request(app).get(`/api/employer/assignments/${id}`).set('Cookie', cookie);
  assert.equal(mine.status, 200);

  const theirs = await request(app).get(`/api/employer/assignments/${id}`).set('Cookie', other.cookie);
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.code, 'ASSIGNMENT_NOT_FOUND');

  const missing = await request(app).get(`/api/employer/assignments/${new ObjectId()}`).set('Cookie', cookie);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ASSIGNMENT_NOT_FOUND');
});

test('PATCH cross-tenant → 404 and the target row is unchanged', async () => {
  const { cookie } = await onboardedCookie('d');
  const other = await onboardedCookie('d2');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;

  const res = await request(app).patch(`/api/employer/assignments/${id}`)
    .set('Cookie', other.cookie).send({ title: 'Hijacked' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ASSIGNMENT_NOT_FOUND');

  const after = await request(app).get(`/api/employer/assignments/${id}`).set('Cookie', cookie);
  assert.equal(after.body.assignment.title, 'Build a rate limiter');
});

test('PATCH applies a valid patch', async () => {
  const { cookie } = await onboardedCookie('e');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  const res = await request(app).patch(`/api/employer/assignments/${id}`).set('Cookie', cookie)
    .send({ title: 'Renamed task', estimatedHours: 6, allowedFileTypes: ['zip', 'zip'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.assignment.title, 'Renamed task');
  assert.equal(res.body.assignment.estimatedHours, 6);
  assert.deepEqual(res.body.assignment.allowedFileTypes, ['zip']);
});

test('PATCH unknown field → 400 UNKNOWN_FIELD naming the field', async () => {
  const { cookie } = await onboardedCookie('f');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  for (const key of ['companyId', 'archivedAt', 'nonsense']) {
    const res = await request(app).patch(`/api/employer/assignments/${id}`).set('Cookie', cookie)
      .send({ [key]: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'UNKNOWN_FIELD');
    assert.match(res.body.error, new RegExp(key));
  }
});

test('PATCH {} → 400 EMPTY_PATCH', async () => {
  const { cookie } = await onboardedCookie('g');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  const res = await request(app).patch(`/api/employer/assignments/${id}`).set('Cookie', cookie).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMPTY_PATCH');
});

test('EDIT LOCK: an in-use assignment → 409 CANNOT_EDIT_USED_ASSIGNMENT listing the jobs', async () => {
  const { cookie, company } = await onboardedCookie('h');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  await attachNativeJob(company._id, id, 'Backend Engineer');

  const res = await request(app).patch(`/api/employer/assignments/${id}`).set('Cookie', cookie)
    .send({ title: 'Sneaky edit' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CANNOT_EDIT_USED_ASSIGNMENT');
  assert.equal(res.body.jobs.length, 1);
  assert.equal(res.body.jobs[0].title, 'Backend Engineer');
  assert.equal(res.body.jobs[0].status, 'active');
  assert.ok(res.body.jobs[0].id);

  const after = await request(app).get(`/api/employer/assignments/${id}`).set('Cookie', cookie);
  assert.equal(after.body.assignment.title, 'Build a rate limiter'); // unchanged
});

test('ARCHIVE LOCK: an in-use assignment → 409 CANNOT_ARCHIVE_USED_ASSIGNMENT listing the jobs', async () => {
  const { cookie, company } = await onboardedCookie('i');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  await attachNativeJob(company._id, id, 'Platform Engineer');

  const res = await request(app).patch(`/api/employer/assignments/${id}/archive`).set('Cookie', cookie).send();
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CANNOT_ARCHIVE_USED_ASSIGNMENT');
  assert.deepEqual(res.body.jobs.map((j) => j.title), ['Platform Engineer']);

  const after = await request(app).get(`/api/employer/assignments/${id}`).set('Cookie', cookie);
  assert.equal(after.body.assignment.archivedAt, null);
});

test('archive with no referencing job → 200 and archivedAt is set', async () => {
  const { cookie } = await onboardedCookie('j');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  const res = await request(app).patch(`/api/employer/assignments/${id}/archive`).set('Cookie', cookie).send();
  assert.equal(res.status, 200);
  assert.ok(res.body.assignment.archivedAt);
});

test('an archived assignment is hidden from the list unless ?includeArchived=true', async () => {
  const { cookie } = await onboardedCookie('k');
  const app = buildApp();
  const live = (await create(app, cookie)).body.assignment.id;
  const gone = (await create(app, cookie, { ...VALID_BODY, title: 'Retired task' })).body.assignment.id;
  await request(app).patch(`/api/employer/assignments/${gone}/archive`).set('Cookie', cookie).send();

  const visible = await request(app).get('/api/employer/assignments').set('Cookie', cookie);
  assert.deepEqual(visible.body.assignments.map((a) => a.id), [live]);

  const all = await request(app).get('/api/employer/assignments?includeArchived=true').set('Cookie', cookie);
  assert.equal(all.body.assignments.length, 2);
  assert.ok(all.body.assignments.some((a) => a.id === gone));
});

test('unarchive clears archivedAt', async () => {
  const { cookie } = await onboardedCookie('l');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  await request(app).patch(`/api/employer/assignments/${id}/archive`).set('Cookie', cookie).send();
  const res = await request(app).patch(`/api/employer/assignments/${id}/unarchive`).set('Cookie', cookie).send();
  assert.equal(res.status, 200);
  assert.equal(res.body.assignment.archivedAt, null);
});

test('CLONE: new id, "(copy)" title, identical content, not archived', async () => {
  const { cookie } = await onboardedCookie('m');
  const app = buildApp();
  const original = (await create(app, cookie)).body.assignment;

  const res = await request(app).post(`/api/employer/assignments/${original.id}/clone`).set('Cookie', cookie).send();
  assert.equal(res.status, 201);
  const clone = res.body.assignment;
  assert.notEqual(clone.id, original.id);
  assert.equal(clone.title, 'Build a rate limiter (copy)');
  assert.equal(clone.publicSummary, original.publicSummary);
  assert.equal(clone.descriptionMarkdown, original.descriptionMarkdown);
  assert.equal(clone.submissionInstructionsMarkdown, original.submissionInstructionsMarkdown);
  assert.equal(clone.estimatedHours, original.estimatedHours);
  assert.deepEqual(clone.allowedFileTypes, original.allowedFileTypes);
  assert.equal(clone.archivedAt, null);
});

test('CLONE of an archived assignment succeeds and the clone is live', async () => {
  const { cookie } = await onboardedCookie('n');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  await request(app).patch(`/api/employer/assignments/${id}/archive`).set('Cookie', cookie).send();

  const res = await request(app).post(`/api/employer/assignments/${id}/clone`).set('Cookie', cookie).send();
  assert.equal(res.status, 201);
  assert.equal(res.body.assignment.archivedAt, null);
  assert.match(res.body.assignment.title, /\(copy\)$/);
});

test('CLONE cross-tenant → 404', async () => {
  const { cookie } = await onboardedCookie('o');
  const other = await onboardedCookie('o2');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  const res = await request(app).post(`/api/employer/assignments/${id}/clone`).set('Cookie', other.cookie).send();
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ASSIGNMENT_NOT_FOUND');
});

// ── Role gates ───────────────────────────────────────────────────────────────
test('gating — interviewer can read the list but cannot create', async () => {
  const { company } = await onboardedCookie('gi');
  const interviewer = await addRoleCookie(company._id, 'interviewer');
  const app = buildApp();
  assert.equal((await request(app).get('/api/employer/assignments').set('Cookie', interviewer)).status, 200);
  assert.equal((await create(app, interviewer)).status, 403);
});

test('gating — member can create but cannot archive; founder can archive', async () => {
  const { cookie, company } = await onboardedCookie('gm');
  const app = buildApp();
  const member = await addRoleCookie(company._id, 'member');

  const created = await create(app, member);
  assert.equal(created.status, 201);
  const id = created.body.assignment.id;

  const memberArchive = await request(app).patch(`/api/employer/assignments/${id}/archive`).set('Cookie', member).send();
  assert.equal(memberArchive.status, 403);

  const founderArchive = await request(app).patch(`/api/employer/assignments/${id}/archive`).set('Cookie', cookie).send();
  assert.equal(founderArchive.status, 200);
  assert.ok(founderArchive.body.assignment.archivedAt);
});

test('gating — member can patch, interviewer cannot', async () => {
  const { cookie, company } = await onboardedCookie('gp');
  const app = buildApp();
  const id = (await create(app, cookie)).body.assignment.id;
  const member = await addRoleCookie(company._id, 'member');
  const interviewer = await addRoleCookie(company._id, 'interviewer');

  assert.equal((await request(app).patch(`/api/employer/assignments/${id}`).set('Cookie', member).send({ title: 'By member' })).status, 200);
  assert.equal((await request(app).patch(`/api/employer/assignments/${id}`).set('Cookie', interviewer).send({ title: 'By interviewer' })).status, 403);
});

test('an assignment seeded straight into the model is visible through the API', async () => {
  const { cookie, company } = await onboardedCookie('p');
  await insertAssignment({
    companyId: company._id, title: 'Seeded task', publicSummary: 'Seeded summary here.',
    descriptionMarkdown: 'x'.repeat(60), estimatedHours: 2,
    submissionInstructionsMarkdown: '', allowedFileTypes: [], createdByEmployerUserId: new ObjectId(),
  });
  const res = await request(buildApp()).get('/api/employer/assignments').set('Cookie', cookie);
  assert.equal(res.body.assignments.length, 1);
  assert.equal(res.body.assignments[0].title, 'Seeded task');
});
