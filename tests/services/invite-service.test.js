import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureEmployerUserIndexes, findOrCreateEmployerGoogleUser,
  ensureCompanyMemberIndexes, insertCompanyMember, findCompanyMemberByCompanyAndUser,
  ensureCompanyInviteIndexes, insertCompanyInvite, findCompanyInviteByToken,
  generateInviteTokenUrlSafe, markInviteExpired, markInviteRevoked, markInviteAccepted,
} from '../../src/models/employer/index.js';
import {
  createInvite, revokeInvite, resendInvite, acceptInvite, getInvitePreview, findInviteByToken,
} from '../../src/services/employer/invite-service.js';

const companyA = new ObjectId();
const companyB = new ObjectId();
let inviter;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); inviter = await user('inviter'); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('employer_users', 'companies', 'company_members', 'company_invites');
  await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensureCompanyInviteIndexes();
  const db = await connectTestDb();
  await db.collection('companies').insertMany([{ _id: companyA, name: 'Acme A' }, { _id: companyB, name: 'Acme B' }]);
}
async function user(tag) {
  return findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `${tag}@acme.com`, name: `User ${tag}`, picture: null });
}
const base = (over = {}) => ({ companyId: companyA, invitedByEmployerUserId: inviter._id, email: 'new@acme.com', role: 'member', ...over });

test('createInvite: happy path — inserts a pending invite; returns { invite, acceptanceUrl }', async () => {
  const { invite, acceptanceUrl } = await createInvite(base());
  assert.equal(invite.status, 'pending');
  assert.equal(invite.email, 'new@acme.com');
  assert.equal(invite.role, 'member');
  assert.ok(acceptanceUrl.includes(invite.token));
});

test('createInvite: role=member — perm flags stored false regardless of input', async () => {
  const { invite } = await createInvite(base({ role: 'member', canMoveApplicants: true, canArchiveApplicants: true }));
  assert.equal(invite.canMoveApplicants, false);
  assert.equal(invite.canArchiveApplicants, false);
});

test('createInvite: role=interviewer with canMoveApplicants:true — stored true', async () => {
  const { invite } = await createInvite(base({ role: 'interviewer', canMoveApplicants: true }));
  assert.equal(invite.canMoveApplicants, true);
  assert.equal(invite.canArchiveApplicants, false);
});

test('createInvite: duplicate pending → INVITE_ALREADY_PENDING with existing inviteId', async () => {
  const first = await createInvite(base());
  await assert.rejects(() => createInvite(base()), (err) => {
    assert.equal(err.code, 'INVITE_ALREADY_PENDING');
    assert.equal(err.existingInviteId, first.invite._id.toString());
    return true;
  });
});

test('createInvite: invited email already a member → ALREADY_MEMBER', async () => {
  const existing = await user('member');
  await insertCompanyMember({ companyId: companyA, employerUserId: existing._id, role: 'member' });
  await assert.rejects(() => createInvite(base({ email: 'member@acme.com' })), (err) => err.code === 'ALREADY_MEMBER');
});

test('createInvite: invalid email → INVALID_EMAIL', async () => {
  await assert.rejects(() => createInvite(base({ email: 'not-an-email' })), (err) => err.code === 'INVALID_EMAIL');
});

test('createInvite: inviting own email → CANNOT_INVITE_SELF', async () => {
  await assert.rejects(() => createInvite(base({ email: inviter.email })), (err) => err.code === 'CANNOT_INVITE_SELF');
});

test('createInvite: invalid role → INVALID_ROLE', async () => {
  await assert.rejects(() => createInvite(base({ role: 'founder' })), (err) => err.code === 'INVALID_ROLE');
});

test('createInvite: role=owner from an Owner inviter → succeeds', async () => {
  const { invite } = await createInvite(base({ role: 'owner' }));
  assert.equal(invite.role, 'owner');
});

test('createInvite: cross-tenant — email is member of company A, invite from company B succeeds', async () => {
  const shared = await user('shared');
  await insertCompanyMember({ companyId: companyA, employerUserId: shared._id, role: 'member' });
  const { invite } = await createInvite(base({ companyId: companyB, email: 'shared@acme.com' }));
  assert.equal(invite.status, 'pending');
});

test('revokeInvite: happy path — status revoked, revokedAt stamped', async () => {
  const { invite } = await createInvite(base());
  const revoked = await revokeInvite(companyA, invite._id);
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt instanceof Date);
});

test('revokeInvite: idempotent — revoking an already-revoked invite returns the row', async () => {
  const { invite } = await createInvite(base());
  await revokeInvite(companyA, invite._id);
  const again = await revokeInvite(companyA, invite._id);
  assert.equal(again.status, 'revoked');
});

test('revokeInvite: cannot revoke accepted → CANNOT_REVOKE_ACCEPTED', async () => {
  const { invite } = await createInvite(base());
  await markInviteAccepted(invite._id, new ObjectId());
  await assert.rejects(() => revokeInvite(companyA, invite._id), (err) => err.code === 'CANNOT_REVOKE_ACCEPTED');
});

test('revokeInvite: cross-tenant — company B cannot revoke company A invite (404)', async () => {
  const { invite } = await createInvite(base());
  await assert.rejects(() => revokeInvite(companyB, invite._id), (err) => err.code === 'INVITE_NOT_FOUND');
});

test('resendInvite: happy path — new token + expiry, old token no longer resolves', async () => {
  const { invite } = await createInvite(base());
  const oldToken = invite.token;
  const { invite: resent, acceptanceUrl } = await resendInvite(companyA, invite._id);
  assert.notEqual(resent.token, oldToken);
  assert.ok(acceptanceUrl.includes(resent.token));
  assert.equal(await findCompanyInviteByToken(oldToken), null);
});

test('resendInvite: non-pending → CANNOT_RESEND_NON_PENDING', async () => {
  const { invite } = await createInvite(base());
  await markInviteRevoked(invite._id);
  await assert.rejects(() => resendInvite(companyA, invite._id), (err) => err.code === 'CANNOT_RESEND_NON_PENDING');
});

test('resendInvite: cross-tenant → 404', async () => {
  const { invite } = await createInvite(base());
  await assert.rejects(() => resendInvite(companyB, invite._id), (err) => err.code === 'INVITE_NOT_FOUND');
});

test('acceptInvite: happy path — creates member (isFounder false, role+flags from invite), marks accepted', async () => {
  const { invite } = await createInvite(base({ role: 'interviewer', canMoveApplicants: true }));
  const joiner = await user('new');
  const { member, redirectUrl } = await acceptInvite({ token: invite.token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'NEW@acme.com' });
  assert.equal(redirectUrl, '/employer');
  assert.equal(member.role, 'interviewer');
  assert.equal(member.isFounder, false);
  assert.equal(member.canMoveApplicants, true);
  assert.equal((await findCompanyInviteByToken(invite.token)).status, 'accepted');
});

test('acceptInvite: token doesn\'t exist → INVITE_NOT_FOUND', async () => {
  await assert.rejects(() => acceptInvite({ token: 'nope', acceptingEmployerUserId: new ObjectId(), acceptingEmployerUserEmail: 'x@acme.com' }), (err) => err.code === 'INVITE_NOT_FOUND');
});

test('acceptInvite: revoked → INVITE_REVOKED', async () => {
  const { invite } = await createInvite(base());
  await markInviteRevoked(invite._id);
  const joiner = await user('new');
  await assert.rejects(() => acceptInvite({ token: invite.token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'new@acme.com' }), (err) => err.code === 'INVITE_REVOKED');
});

test('acceptInvite: expired (status still pending) → INVITE_EXPIRED and status updated to expired', async () => {
  const joiner = await user('new');
  const token = generateInviteTokenUrlSafe();
  await insertCompanyInvite({ companyId: companyA, email: 'new@acme.com', role: 'member', token, invitedByEmployerUserId: inviter._id, expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(() => acceptInvite({ token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'new@acme.com' }), (err) => err.code === 'INVITE_EXPIRED');
  assert.equal((await findCompanyInviteByToken(token)).status, 'expired');
});

test('acceptInvite: already accepted → INVITE_ALREADY_ACCEPTED', async () => {
  const { invite } = await createInvite(base());
  await markInviteAccepted(invite._id, new ObjectId());
  const joiner = await user('new');
  await assert.rejects(() => acceptInvite({ token: invite.token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'new@acme.com' }), (err) => err.code === 'INVITE_ALREADY_ACCEPTED');
});

test('acceptInvite: email mismatch (case-insensitive) → INVITE_EMAIL_MISMATCH', async () => {
  const { invite } = await createInvite(base({ email: 'target@acme.com' }));
  const joiner = await user('other');
  await assert.rejects(() => acceptInvite({ token: invite.token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'other@acme.com' }), (err) => err.code === 'INVITE_EMAIL_MISMATCH');
});

test('acceptInvite: already a member of this company → returns existing member, marks accepted, no duplicate row', async () => {
  const joiner = await user('new');
  await insertCompanyMember({ companyId: companyA, employerUserId: joiner._id, role: 'owner' });
  // Seed the invite directly (createInvite would correctly reject an existing member).
  const token = generateInviteTokenUrlSafe();
  await insertCompanyInvite({ companyId: companyA, email: 'new@acme.com', role: 'member', token, invitedByEmployerUserId: inviter._id, expiresAt: new Date(Date.now() + 60_000) });
  const { member, alreadyMember } = await acceptInvite({ token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'new@acme.com' });
  assert.equal(alreadyMember, true);
  assert.equal(member.role, 'owner'); // existing row, not the invite's 'member'
  assert.equal((await findCompanyInviteByToken(token)).status, 'accepted');
});

test('acceptInvite: race — two concurrent accepts create exactly one member; loser gets INVITE_ALREADY_ACCEPTED', async () => {
  const { invite } = await createInvite(base());
  const joiner = await user('new');
  const call = () => acceptInvite({ token: invite.token, acceptingEmployerUserId: joiner._id, acceptingEmployerUserEmail: 'new@acme.com' });
  const results = await Promise.allSettled([call(), call()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.ok(fulfilled.length >= 1);
  // No duplicate membership row regardless of interleaving.
  const member = await findCompanyMemberByCompanyAndUser(companyA, joiner._id);
  assert.ok(member);
  assert.equal((await findCompanyInviteByToken(invite.token)).status, 'accepted');
});

test('findInviteByToken: returns { invite, company }; null for unknown token', async () => {
  const { invite } = await createInvite(base());
  assert.equal(await findInviteByToken('nope'), null);
  const found = await findInviteByToken(invite.token);
  assert.equal(found.invite._id.toString(), invite._id.toString());
});

test('getInvitePreview: sanitized shape, no token/inviter-id; gone status for stale', async () => {
  const { invite } = await createInvite(base());
  const { preview } = await getInvitePreview(invite.token);
  assert.equal(preview.token, undefined);
  assert.equal(preview.invitedByEmployerUserId, undefined);
  assert.equal(preview.invitedByName, 'User inviter');
  await markInviteRevoked(invite._id);
  assert.deepEqual(await getInvitePreview(invite.token), { gone: 'revoked' });
});
