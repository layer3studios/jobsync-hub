import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureCompanyMemberIndexes, insertCompanyMember, findCompanyMemberByCompanyAndUser,
} from '../../src/models/employer/company-member-model.js';
import {
  patchMember, removeMember, transferFounder,
} from '../../src/services/employer/member-management-service.js';

const companyA = new ObjectId();
const companyB = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('company_members');
  await ensureCompanyMemberIndexes();
}
/** Seed a member; returns the doc (has _id + employerUserId). */
function seed(companyId, role, extra = {}) {
  return insertCompanyMember({
    companyId, employerUserId: new ObjectId(), role, isFounder: role === 'founder', ...extra,
  });
}
const actorOf = (member) => ({ actorRole: member.role, actorEmployerUserId: member.employerUserId });

// ── patchMember ──────────────────────────────────────────────────────────────
test('patchMember: Owner changes Member to Interviewer', async () => {
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'member');
  const updated = await patchMember(companyA, target._id, { role: 'interviewer' }, actorOf(owner));
  assert.equal(updated.role, 'interviewer');
  assert.equal(updated.isFounder, false);
});
test('patchMember: Owner changes Interviewer to Member (flags become irrelevant)', async () => {
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'interviewer', { canMoveApplicants: true });
  const updated = await patchMember(companyA, target._id, { role: 'member' }, actorOf(owner));
  assert.equal(updated.role, 'member');
});
test('patchMember: Owner sets canMoveApplicants=true on an Interviewer', async () => {
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'interviewer');
  const updated = await patchMember(companyA, target._id, { canMoveApplicants: true }, actorOf(owner));
  assert.equal(updated.canMoveApplicants, true);
});
test('patchMember: cannot patch Founder\'s role — CANNOT_PATCH_FOUNDER', async () => {
  const owner = await seed(companyA, 'owner');
  const founder = await seed(companyA, 'founder');
  await assert.rejects(() => patchMember(companyA, founder._id, { role: 'member' }, actorOf(owner)), (e) => e.code === 'CANNOT_PATCH_FOUNDER');
});
test('patchMember: cannot patch role to founder — INVALID_ROLE', async () => {
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'member');
  await assert.rejects(() => patchMember(companyA, target._id, { role: 'founder' }, actorOf(owner)), (e) => e.code === 'INVALID_ROLE');
});
test('patchMember: cannot patch yourself — SELF_ROLE_CHANGE_FORBIDDEN', async () => {
  const owner = await seed(companyA, 'owner');
  await assert.rejects(() => patchMember(companyA, owner._id, { role: 'member' }, actorOf(owner)), (e) => e.code === 'SELF_ROLE_CHANGE_FORBIDDEN');
});
test('patchMember: cross-tenant — 404 MEMBER_NOT_FOUND', async () => {
  const owner = await seed(companyB, 'owner');
  const target = await seed(companyA, 'member');
  await assert.rejects(() => patchMember(companyB, target._id, { role: 'interviewer' }, actorOf(owner)), (e) => e.code === 'MEMBER_NOT_FOUND');
});
test('patchMember: canMoveApplicants on a Member is stored false (ignored)', async () => {
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'member');
  const updated = await patchMember(companyA, target._id, { canMoveApplicants: true }, actorOf(owner));
  assert.equal(updated.canMoveApplicants, false);
});

// ── removeMember ─────────────────────────────────────────────────────────────
test('removeMember: Owner removes Member', async () => {
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'member');
  const res = await removeMember(companyA, target._id, actorOf(owner));
  assert.equal(res.removed, true);
  assert.equal(await findCompanyMemberByCompanyAndUser(companyA, target.employerUserId), null);
});
test('removeMember: cannot remove Founder — CANNOT_REMOVE_FOUNDER', async () => {
  const owner = await seed(companyA, 'owner');
  const founder = await seed(companyA, 'founder');
  await assert.rejects(() => removeMember(companyA, founder._id, actorOf(owner)), (e) => e.code === 'CANNOT_REMOVE_FOUNDER');
});
test('removeMember: Founder cannot self-remove — CANNOT_REMOVE_SELF_FOUNDER', async () => {
  const founder = await seed(companyA, 'founder');
  await assert.rejects(() => removeMember(companyA, founder._id, actorOf(founder)), (e) => e.code === 'CANNOT_REMOVE_SELF_FOUNDER');
});
test('removeMember: Owner can self-remove (Founder present)', async () => {
  await seed(companyA, 'founder');
  const owner = await seed(companyA, 'owner');
  const res = await removeMember(companyA, owner._id, actorOf(owner));
  assert.equal(res.removed, true);
});
test('removeMember: Interviewer can self-remove', async () => {
  await seed(companyA, 'founder');
  const interviewer = await seed(companyA, 'interviewer');
  const res = await removeMember(companyA, interviewer._id, actorOf(interviewer));
  assert.equal(res.removed, true);
});
test('removeMember: cross-tenant — 404', async () => {
  const owner = await seed(companyB, 'owner');
  const target = await seed(companyA, 'member');
  await assert.rejects(() => removeMember(companyB, target._id, actorOf(owner)), (e) => e.code === 'MEMBER_NOT_FOUND');
});

// ── transferFounder ──────────────────────────────────────────────────────────
test('transferFounder: Founder to Owner atomically flips both', async () => {
  const founder = await seed(companyA, 'founder');
  const target = await seed(companyA, 'owner');
  const res = await transferFounder(companyA, target._id, { actorEmployerUserId: founder.employerUserId });
  assert.equal(res.toMemberId, target._id.toString());
  assert.equal((await findCompanyMemberByCompanyAndUser(companyA, target.employerUserId)).isFounder, true);
  assert.equal((await findCompanyMemberByCompanyAndUser(companyA, founder.employerUserId)).isFounder, false);
});
test('transferFounder: target not an Owner (Member) — TARGET_NOT_OWNER', async () => {
  const founder = await seed(companyA, 'founder');
  const target = await seed(companyA, 'member');
  await assert.rejects(() => transferFounder(companyA, target._id, { actorEmployerUserId: founder.employerUserId }), (e) => e.code === 'TARGET_NOT_OWNER');
});
test('transferFounder: cannot transfer to self — CANNOT_TRANSFER_TO_SELF', async () => {
  const founder = await seed(companyA, 'founder');
  await assert.rejects(() => transferFounder(companyA, founder._id, { actorEmployerUserId: founder.employerUserId }), (e) => e.code === 'CANNOT_TRANSFER_TO_SELF');
});
test('transferFounder: actor not Founder — NOT_FOUNDER', async () => {
  await seed(companyA, 'founder');
  const owner = await seed(companyA, 'owner');
  const target = await seed(companyA, 'owner');
  await assert.rejects(() => transferFounder(companyA, target._id, { actorEmployerUserId: owner.employerUserId }), (e) => e.code === 'NOT_FOUNDER');
});
test('transferFounder: second-write failure rolls back to the original state', async () => {
  const founder = await seed(companyA, 'founder');
  const target = await seed(companyA, 'owner');
  const boom = () => { throw new Error('promote failed'); };
  await assert.rejects(
    () => transferFounder(companyA, target._id, { actorEmployerUserId: founder.employerUserId }, { promote: boom }),
    (e) => e.code === 'TRANSFER_FAILED',
  );
  // State restored: original Founder still Founder, target still a plain Owner.
  assert.equal((await findCompanyMemberByCompanyAndUser(companyA, founder.employerUserId)).isFounder, true);
  const targetAfter = await findCompanyMemberByCompanyAndUser(companyA, target.employerUserId);
  assert.equal(targetAfter.isFounder, false);
  assert.equal(targetAfter.role, 'owner');
});
test('transferFounder: cross-tenant — 404', async () => {
  const founder = await seed(companyB, 'founder');
  const target = await seed(companyA, 'owner');
  await assert.rejects(() => transferFounder(companyB, target._id, { actorEmployerUserId: founder.employerUserId }), (e) => e.code === 'MEMBER_NOT_FOUND');
});
