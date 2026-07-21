// FILE: tests/api/employer-applicant-notes-routes.test.js
// Note endpoints on /api/employer/applicants/:applicationId/notes (C3). Split out of
// employer-applicant-routes.test.js to keep both files under the 200-line cap (C1).
// Same harness: a real onboarded company for a valid cookie, applications inserted directly.
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
import employerApplicantRouter from '../../src/api/employer/employer-applicant-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser,
  insertCompanyMember, ensureCompanyMemberIndexes,
} from '../../src/models/employer/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerApplicantRouter);
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

async function seedApplicant(companyId, { stageId, archived = null }) {
  const contact = await (await col('contacts')).insertOne({ companyId, email: 'asha@x.com', fullName: 'Asha' });
  const application = await (await col('applications')).insertOne({
    companyId, contactId: contact.insertedId, jobId: new ObjectId(), stageId, archived, appliedAt: new Date(),
  });
  return application.insertedId;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('companies', 'company_members', 'employer_users', 'applications', 'contacts', 'applicant_notes');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
}

// The notes endpoints sit behind the same requireEmployer + requireEmployerCompany +
// requireEmployerApplicant chain as the other per-applicant routes, so these cases
// assert the auth/tenant boundary as well as the happy path.
function postNote(app, cookie, applicationId, body) {
  const req = request(app).post(`/api/employer/applicants/${applicationId}/notes`);
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
}

test('GET notes returns 200 with an empty array for an application with no notes', async () => {
  const { cookie, company } = await onboardedCookie('k');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await request(buildApp()).get(`/api/employer/applicants/${appId}/notes`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notes, []);
});

test('POST note with a valid body returns 201 and the created note in client shape', async () => {
  const { cookie, company } = await onboardedCookie('l');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await postNote(buildApp(), cookie, appId, { body: '  Strong on backend.  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.note.body, 'Strong on backend.'); // trimmed before write
  assert.equal(res.body.note.applicationId, appId.toString());
  assert.equal(typeof res.body.note.id, 'string');
  // Author snapshot is denormalized from the signed-in employer user (D7).
  assert.equal(res.body.note.authorEmail, 'ol@acme.com');
  assert.equal(res.body.note.authorName, 'Owner');
  // Timestamps serialize as ISO strings over JSON (C11); companyId never ships.
  assert.match(res.body.note.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(res.body.note.companyId, undefined);
});

test('GET notes returns notes newest first', async () => {
  const { cookie, company } = await onboardedCookie('m');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  await postNote(buildApp(), cookie, appId, { body: 'first note' });
  await postNote(buildApp(), cookie, appId, { body: 'second note' });
  const res = await request(buildApp()).get(`/api/employer/applicants/${appId}/notes`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.notes.length, 2);
  assert.equal(res.body.notes[0].body, 'second note');
  assert.equal(res.body.notes[1].body, 'first note');
});

test('POST note with the body missing entirely → 400 INVALID_NOTE_BODY', async () => {
  const { cookie, company } = await onboardedCookie('n');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await postNote(buildApp(), cookie, appId, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_NOTE_BODY');
});

test('POST note with a body over 4000 chars → 400 INVALID_NOTE_BODY', async () => {
  const { cookie, company } = await onboardedCookie('o');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await postNote(buildApp(), cookie, appId, { body: 'x'.repeat(4001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_NOTE_BODY');
});

test('POST note containing "<script" → 400 INVALID_NOTE_BODY', async () => {
  const { cookie, company } = await onboardedCookie('p');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await postNote(buildApp(), cookie, appId, { body: '<script>alert(1)</script>' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_NOTE_BODY');
});

test('POST note on a cross-tenant applicationId → 404 APPLICATION_NOT_FOUND', async () => {
  const { cookie } = await onboardedCookie('q');
  const other = await onboardedCookie('r');
  // An application that genuinely exists — but under ANOTHER company (§6.5).
  const foreignAppId = await seedApplicant(other.company._id, { stageId: new ObjectId() });
  const res = await postNote(buildApp(), cookie, foreignAppId, { body: 'peeking' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'APPLICATION_NOT_FOUND');
  // The foreign application's owner still sees no note written by the intruder.
  const owner = await request(buildApp()).get(`/api/employer/applicants/${foreignAppId}/notes`).set('Cookie', other.cookie);
  assert.deepEqual(owner.body.notes, []);
});

test('POST note without an auth cookie → 401', async () => {
  const res = await postNote(buildApp(), null, new ObjectId(), { body: 'anon' });
  assert.equal(res.status, 401);
});

test('GET notes without an auth cookie → 401', async () => {
  const res = await request(buildApp()).get(`/api/employer/applicants/${new ObjectId()}/notes`);
  assert.equal(res.status, 401);
});
