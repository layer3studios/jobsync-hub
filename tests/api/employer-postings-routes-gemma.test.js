// FILE: tests/api/employer-postings-routes-gemma.test.js
// Verifies the fire-and-forget Gemma hook on posting create/update. The route
// uses the boot-time singleton client, so we stub globalThis.fetch BEFORE
// initGemma (the client captures fetch at construction) and assert the extraction
// HTTP call fires (or not). Extraction is async/fire-and-forget, so we await a
// short tick after each request before asserting the fetch count.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { EMPLOYER_JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireEmployer } from '../../src/middleware/require-employer-middleware.js';
import { requireEmployerCompany } from '../../src/middleware/require-employer-company-middleware.js';
import employerPostingsRouter from '../../src/api/employer/employer-postings-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensurePostingIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser,
  insertCompanyMember, ensureCompanyMemberIndexes,
} from '../../src/models/employer/index.js';
import { initGemma } from '../../src/gemma/index.js';

const VALID_BODY = {
  title: 'React Developer', description: 'x'.repeat(60), location: 'Bangalore',
  workplaceType: 'remote', employmentType: 'full-time',
};

let fetchCount = 0;
const originalFetch = globalThis.fetch;
const tick = () => new Promise((resolve) => setTimeout(resolve, 80));

function stubGemmaFetch() {
  fetchCount = 0;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '{"required_skills":[]}' }] } }] }),
    text: async () => '',
  });
  globalThis.fetch = new Proxy(globalThis.fetch, { apply(target, thisArg, argv) { fetchCount += 1; return Reflect.apply(target, thisArg, argv); } });
  initGemma('fake-key-1'); // client captures the stubbed fetch
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerPostingsRouter);
  app.use(errorHandler);
  return app;
}

async function onboardedCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return `jm_employer_token=${token}`;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); stubGemmaFetch(); });
after(async () => { globalThis.fetch = originalFetch; await closeTestDb(); });
async function reset() {
  await dropCollections('jobs', 'companies', 'company_members', 'employer_users');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensurePostingIndexes();
}

test('POST create triggers background extraction', async () => {
  const cookie = await onboardedCookie('a');
  const res = await request(buildApp()).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  assert.equal(res.status, 201);
  await tick();
  assert.equal(fetchCount, 1);
});

test('PATCH with a new description triggers extraction', async () => {
  const cookie = await onboardedCookie('b');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  await tick();
  fetchCount = 0;
  const res = await request(app).patch(`/api/employer/jobs/${created.body.posting.id}`)
    .set('Cookie', cookie).send({ description: 'y'.repeat(70) });
  assert.equal(res.status, 200);
  await tick();
  assert.equal(fetchCount, 1);
});

test('PATCH without a description change does NOT trigger extraction', async () => {
  const cookie = await onboardedCookie('c');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  await tick();
  fetchCount = 0;
  const res = await request(app).patch(`/api/employer/jobs/${created.body.posting.id}`)
    .set('Cookie', cookie).send({ status: 'closed' });
  assert.equal(res.status, 200);
  await tick();
  assert.equal(fetchCount, 0);
});
