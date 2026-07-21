import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureCompanyInviteIndexes, insertCompanyInvite, findCompanyInviteByToken,
  findPendingInvitesByCompanyId, findPendingInviteByCompanyAndEmail,
  markInviteRevoked, markInviteAccepted, generateInviteToken,
} from '../../src/models/employer/company-invite-model.js';

const companyA = new ObjectId();
const companyB = new ObjectId();
const inviter = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('company_invites');
  await ensureCompanyInviteIndexes();
}

function inviteInput(overrides = {}) {
  return {
    companyId: companyA, email: 'teammate@acme.com', role: 'member',
    token: generateInviteToken(), invitedByEmployerUserId: inviter, ...overrides,
  };
}

test('ensureCompanyInviteIndexes creates the three expected indexes', async () => {
  const db = await connectTestDb();
  const names = (await db.collection('company_invites').indexes()).map((i) => i.name);
  assert.ok(names.includes('company_invites_token'));
  assert.ok(names.includes('company_invites_pending_email'));
  assert.ok(names.includes('company_invites_status_expiresAt'));
});

test('insertCompanyInvite happy path with a fresh token', async () => {
  const doc = await insertCompanyInvite(inviteInput());
  assert.equal(doc.status, 'pending');
  assert.equal(doc.email, 'teammate@acme.com');
  assert.equal(doc.token.length, 64);
  assert.ok(doc.expiresAt instanceof Date);
  assert.equal(doc.acceptedAt, null);
});

test('two pending invites to the same email in the same company → second fails on the partial unique index', async () => {
  await insertCompanyInvite(inviteInput());
  await assert.rejects(
    () => insertCompanyInvite(inviteInput()),
    (err) => err.code === 11000,
  );
});

test('two invites with the same token (across companies) → second fails on the token unique index', async () => {
  const token = generateInviteToken();
  await insertCompanyInvite(inviteInput({ token }));
  await assert.rejects(
    () => insertCompanyInvite(inviteInput({ companyId: companyB, email: 'other@acme.com', token })),
    (err) => err.code === 11000,
  );
});

test('findCompanyInviteByToken returns the invite regardless of company (that\'s expected — service layer scopes)', async () => {
  const doc = await insertCompanyInvite(inviteInput({ companyId: companyB }));
  const found = await findCompanyInviteByToken(doc.token);
  assert.equal(found._id.toString(), doc._id.toString());
});

test('findPendingInvitesByCompanyId excludes revoked/accepted/expired rows', async () => {
  const pending = await insertCompanyInvite(inviteInput({ email: 'p@acme.com' }));
  const toRevoke = await insertCompanyInvite(inviteInput({ email: 'r@acme.com' }));
  await markInviteRevoked(toRevoke._id);
  const rows = await findPendingInvitesByCompanyId(companyA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._id.toString(), pending._id.toString());
});

test('findPendingInviteByCompanyAndEmail returns pending only', async () => {
  const doc = await insertCompanyInvite(inviteInput({ email: 'x@acme.com' }));
  assert.ok(await findPendingInviteByCompanyAndEmail(companyA, 'x@acme.com'));
  await markInviteRevoked(doc._id);
  assert.equal(await findPendingInviteByCompanyAndEmail(companyA, 'x@acme.com'), null);
});

test('markInviteRevoked flips status + updates updatedAt', async () => {
  const doc = await insertCompanyInvite(inviteInput());
  const revoked = await markInviteRevoked(doc._id);
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.updatedAt.getTime() >= doc.updatedAt.getTime());
});

test('markInviteAccepted sets acceptedAt + acceptedByEmployerUserId', async () => {
  const doc = await insertCompanyInvite(inviteInput());
  const acceptor = new ObjectId();
  const accepted = await markInviteAccepted(doc._id, acceptor);
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.acceptedAt instanceof Date);
  assert.equal(accepted.acceptedByEmployerUserId.toString(), acceptor.toString());
});
