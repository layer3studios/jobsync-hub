import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureCompanyMemberIndexes, insertCompanyMember, findCompanyMembersByCompanyId,
  findCompanyMemberByCompanyAndUser, findFounderForCompany, updateCompanyMemberRole,
  updateCompanyMemberInterviewerPerms, deleteCompanyMember,
} from '../../src/models/employer/company-member-model.js';

const companyA = new ObjectId();
const companyB = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('company_members');
  await ensureCompanyMemberIndexes();
}

test('ensureCompanyMemberIndexes creates the three expected indexes', async () => {
  const db = await connectTestDb();
  const names = (await db.collection('company_members').indexes()).map((i) => i.name);
  assert.ok(names.includes('company_members_companyId_employerUserId'));
  assert.ok(names.includes('company_members_companyId_founder'));
  assert.ok(names.includes('company_members_employerUserId'));
});

test("insertCompanyMember happy path — role='member', isFounder=false, defaults on interviewer perms", async () => {
  const doc = await insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'member' });
  assert.equal(doc.role, 'member');
  assert.equal(doc.isFounder, false);
  assert.equal(doc.canMoveApplicants, false);
  assert.equal(doc.canArchiveApplicants, false);
  assert.ok(doc.joinedAt instanceof Date);
});

test("insertCompanyMember rejects role='founder' with isFounder=false (invariant D1)", async () => {
  await assert.rejects(() => insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'founder', isFounder: false }));
});

test("insertCompanyMember with role='founder' and isFounder=true succeeds", async () => {
  const doc = await insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'founder', isFounder: true });
  assert.equal(doc.isFounder, true);
  assert.equal(doc.role, 'founder');
});

test('two founders for the same company → second insert fails with E11000 on the partial unique index', async () => {
  await insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'founder', isFounder: true });
  await assert.rejects(
    () => insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'founder', isFounder: true }),
    (err) => err.code === 11000,
  );
});

test('two members with the same (companyId, employerUserId) → second fails with E11000 on the compound unique index', async () => {
  const userId = new ObjectId();
  await insertCompanyMember({ companyId: companyA, employerUserId: userId, role: 'member' });
  await assert.rejects(
    () => insertCompanyMember({ companyId: companyA, employerUserId: userId, role: 'interviewer' }),
    (err) => err.code === 11000,
  );
});

test('findCompanyMembersByCompanyId returns only that company\'s members (cross-tenant safety)', async () => {
  await insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'member' });
  await insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'interviewer' });
  await insertCompanyMember({ companyId: companyB, employerUserId: new ObjectId(), role: 'owner' });
  const a = await findCompanyMembersByCompanyId(companyA);
  const b = await findCompanyMembersByCompanyId(companyB);
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  assert.ok(a.every((m) => m.companyId.toString() === companyA.toString()));
});

test('findCompanyMemberByCompanyAndUser returns null for a wrong companyId', async () => {
  const userId = new ObjectId();
  await insertCompanyMember({ companyId: companyA, employerUserId: userId, role: 'member' });
  assert.equal(await findCompanyMemberByCompanyAndUser(companyB, userId), null);
  assert.ok(await findCompanyMemberByCompanyAndUser(companyA, userId));
});

test('findFounderForCompany returns exactly the founder', async () => {
  const founderId = new ObjectId();
  await insertCompanyMember({ companyId: companyA, employerUserId: founderId, role: 'founder', isFounder: true });
  await insertCompanyMember({ companyId: companyA, employerUserId: new ObjectId(), role: 'member' });
  const founder = await findFounderForCompany(companyA);
  assert.equal(founder.employerUserId.toString(), founderId.toString());
  assert.equal(founder.isFounder, true);
});

test("updateCompanyMemberRole from 'interviewer' to 'member' preserves interviewer perms flags", async () => {
  const userId = new ObjectId();
  await insertCompanyMember({ companyId: companyA, employerUserId: userId, role: 'interviewer', canMoveApplicants: true, canArchiveApplicants: true });
  const updated = await updateCompanyMemberRole(companyA, userId, 'member');
  assert.equal(updated.role, 'member');
  assert.equal(updated.isFounder, false);
  assert.equal(updated.canMoveApplicants, true);
  assert.equal(updated.canArchiveApplicants, true);
});

test('updateCompanyMemberInterviewerPerms toggles the two flags', async () => {
  const userId = new ObjectId();
  await insertCompanyMember({ companyId: companyA, employerUserId: userId, role: 'interviewer' });
  const updated = await updateCompanyMemberInterviewerPerms(companyA, userId, { canMoveApplicants: true, canArchiveApplicants: false });
  assert.equal(updated.canMoveApplicants, true);
  assert.equal(updated.canArchiveApplicants, false);
});

test('deleteCompanyMember removes the row', async () => {
  const userId = new ObjectId();
  await insertCompanyMember({ companyId: companyA, employerUserId: userId, role: 'member' });
  assert.equal(await deleteCompanyMember(companyA, userId), 1);
  assert.equal(await findCompanyMemberByCompanyAndUser(companyA, userId), null);
});
