import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureEmployerUserIndexes, findOrCreateEmployerGoogleUser,
  ensureCompanyMemberIndexes, insertCompanyMember,
  ensureCompanyInviteIndexes, insertCompanyInvite, generateInviteToken,
} from '../../src/models/employer/index.js';
import { getTeamMembersForCompany, getPendingInvitesForCompany } from '../../src/services/employer/team-service.js';

const companyA = new ObjectId();
const companyB = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('employer_users', 'company_members', 'company_invites');
  await ensureEmployerUserIndexes();
  await ensureCompanyMemberIndexes();
  await ensureCompanyInviteIndexes();
}

async function seedUser(tag) {
  return findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `${tag}@acme.com`, name: `User ${tag}`, picture: `https://pic/${tag}.jpg` });
}

test('getTeamMembersForCompany joins names/emails/pictures from employer_users', async () => {
  const user = await seedUser('founder');
  await insertCompanyMember({ companyId: companyA, employerUserId: user._id, role: 'founder', isFounder: true });
  const [row] = await getTeamMembersForCompany(companyA);
  assert.equal(row.name, 'User founder');
  assert.equal(row.email, 'founder@acme.com');
  assert.equal(row.picture, 'https://pic/founder.jpg');
  assert.equal(row.role, 'founder');
  assert.equal(row.isFounder, true);
  assert.equal(row.employerUserId, user._id.toString());
});

test('getTeamMembersForCompany is multi-tenant safe', async () => {
  const a = await seedUser('a');
  const b = await seedUser('b');
  await insertCompanyMember({ companyId: companyA, employerUserId: a._id, role: 'founder', isFounder: true });
  await insertCompanyMember({ companyId: companyB, employerUserId: b._id, role: 'founder', isFounder: true });
  const membersA = await getTeamMembersForCompany(companyA);
  assert.equal(membersA.length, 1);
  assert.equal(membersA[0].email, 'a@acme.com');
});

test('getTeamMembersForCompany returns [] for a company with no members', async () => {
  assert.deepEqual(await getTeamMembersForCompany(companyA), []);
});

test('getPendingInvitesForCompany returns pending invites, excludes expired (where expiresAt < now)', async () => {
  const inviter = new ObjectId();
  await insertCompanyInvite({ companyId: companyA, email: 'live@acme.com', role: 'member', token: generateInviteToken(), invitedByEmployerUserId: inviter });
  await insertCompanyInvite({ companyId: companyA, email: 'stale@acme.com', role: 'member', token: generateInviteToken(), invitedByEmployerUserId: inviter, expiresAt: new Date(Date.now() - 1000) });
  const invites = await getPendingInvitesForCompany(companyA);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].email, 'live@acme.com');
  assert.equal(invites[0].token, undefined); // token never leaked in the projection
});
