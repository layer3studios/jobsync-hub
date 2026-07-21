import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { ensureCompanyMemberIndexes, insertCompanyMember } from '../../src/models/employer/company-member-model.js';
import {
  requireFounder, requireOwnerOrHigher, requireMemberOrHigher, requireInterviewerOrHigher,
  requireCanMoveApplicants, requireCanArchiveApplicants,
} from '../../src/middleware/require-company-role-middleware.js';

const companyId = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('company_members');
  await ensureCompanyMemberIndexes();
}

/** Seed a member and return its employerUserId. */
async function seed(role, perms = {}) {
  const employerUserId = new ObjectId();
  await insertCompanyMember({
    companyId, employerUserId, role, isFounder: role === 'founder',
    canMoveApplicants: perms.canMove ?? false, canArchiveApplicants: perms.canArchive ?? false,
  });
  return employerUserId;
}

/** Run a middleware with a mocked req; resolve to { err, req } (err=undefined on pass). */
function run(middleware, employerUserId) {
  return new Promise((resolve) => {
    const req = { employerCompanyId: companyId, employerUser: { employerUserId: employerUserId?.toString() } };
    middleware(req, {}, (err) => resolve({ err, req }));
  });
}

test('requireFounder: founder → next(); owner/member/interviewer → 403 INSUFFICIENT_ROLE; no row → 403 COMPANY_MEMBERSHIP_NOT_FOUND', async () => {
  assert.equal((await run(requireFounder, await seed('founder'))).err, undefined);
  for (const role of ['owner', 'member', 'interviewer']) {
    const { err } = await run(requireFounder, await seed(role));
    assert.equal(err.code, 'INSUFFICIENT_ROLE');
    assert.equal(err.status, 403);
  }
  const missing = await run(requireFounder, new ObjectId());
  assert.equal(missing.err.code, 'COMPANY_MEMBERSHIP_NOT_FOUND');
});

test('requireOwnerOrHigher: founder/owner → next(); member/interviewer → 403 INSUFFICIENT_ROLE', async () => {
  assert.equal((await run(requireOwnerOrHigher, await seed('founder'))).err, undefined);
  assert.equal((await run(requireOwnerOrHigher, await seed('owner'))).err, undefined);
  assert.equal((await run(requireOwnerOrHigher, await seed('member'))).err.code, 'INSUFFICIENT_ROLE');
  assert.equal((await run(requireOwnerOrHigher, await seed('interviewer'))).err.code, 'INSUFFICIENT_ROLE');
});

test('requireMemberOrHigher: founder/owner/member → next(); interviewer → 403 INSUFFICIENT_ROLE', async () => {
  for (const role of ['founder', 'owner', 'member']) {
    assert.equal((await run(requireMemberOrHigher, await seed(role))).err, undefined);
  }
  assert.equal((await run(requireMemberOrHigher, await seed('interviewer'))).err.code, 'INSUFFICIENT_ROLE');
});

test('requireInterviewerOrHigher: all four → next(); missing row → 403 COMPANY_MEMBERSHIP_NOT_FOUND', async () => {
  for (const role of ['founder', 'owner', 'member', 'interviewer']) {
    assert.equal((await run(requireInterviewerOrHigher, await seed(role))).err, undefined);
  }
  assert.equal((await run(requireInterviewerOrHigher, new ObjectId())).err.code, 'COMPANY_MEMBERSHIP_NOT_FOUND');
});

test('requireCanMoveApplicants: founder/owner/member always; interviewer true → next(); interviewer false → 403 INSUFFICIENT_INTERVIEWER_PERMS', async () => {
  for (const role of ['founder', 'owner', 'member']) {
    assert.equal((await run(requireCanMoveApplicants, await seed(role))).err, undefined);
  }
  assert.equal((await run(requireCanMoveApplicants, await seed('interviewer', { canMove: true }))).err, undefined);
  assert.equal((await run(requireCanMoveApplicants, await seed('interviewer', { canMove: false }))).err.code, 'INSUFFICIENT_INTERVIEWER_PERMS');
});

test('requireCanArchiveApplicants: founder/owner/member always; interviewer true → next(); interviewer false → 403 INSUFFICIENT_INTERVIEWER_PERMS', async () => {
  for (const role of ['founder', 'owner', 'member']) {
    assert.equal((await run(requireCanArchiveApplicants, await seed(role))).err, undefined);
  }
  assert.equal((await run(requireCanArchiveApplicants, await seed('interviewer', { canArchive: true }))).err, undefined);
  assert.equal((await run(requireCanArchiveApplicants, await seed('interviewer', { canArchive: false }))).err.code, 'INSUFFICIENT_INTERVIEWER_PERMS');
});

test('all middleware attach req.companyMemberRole and req.companyMemberPermissions on success', async () => {
  const { req } = await run(requireInterviewerOrHigher, await seed('interviewer', { canMove: true }));
  assert.equal(req.companyMemberRole, 'interviewer');
  assert.deepEqual(req.companyMemberPermissions, { canMoveApplicants: true, canArchiveApplicants: false });
});
