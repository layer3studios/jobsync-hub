// FILE: tests/models/admin-user-model.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureAdminUserIndexes, findAdminByEmail, findAdminById,
  upsertAdminByEmail, markAdminLoggedIn,
  listAdmins, findAdminByInviteToken, createAdminInvite, activateAdminByInviteToken,
  deactivateAdmin, reactivateAdmin, updateAdminRole,
  resendAdminInvite, revokeAdminInvite,
} from '../../src/models/admin/index.js';

async function reset() {
  await dropCollections('admin_users');
  await ensureAdminUserIndexes();
}

before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('findAdminByEmail returns null when no row', async () => {
  assert.equal(await findAdminByEmail('nobody@x.com'), null);
});

test('findAdminByEmail returns the row when an active row matches', async () => {
  await upsertAdminByEmail({ email: 'ashish@x.com', role: 'admin' });
  const found = await findAdminByEmail('ashish@x.com');
  assert.equal(found.email, 'ashish@x.com');
});

test('findAdminByEmail is case-insensitive', async () => {
  await upsertAdminByEmail({ email: 'ashish@x.com' });
  const found = await findAdminByEmail('ASHISH@X.com');
  assert.ok(found);
  assert.equal(found.email, 'ashish@x.com');
});

test('findAdminByEmail returns null when the row is isActive:false', async () => {
  await upsertAdminByEmail({ email: 'gone@x.com' });
  await (await col('admin_users')).updateOne({ email: 'gone@x.com' }, { $set: { isActive: false } });
  assert.equal(await findAdminByEmail('gone@x.com'), null);
});

test('findAdminById returns null for an unknown id', async () => {
  assert.equal(await findAdminById(new ObjectId().toString()), null);
});

test('findAdminById returns the row for a known active id', async () => {
  const row = await upsertAdminByEmail({ email: 'a@x.com' });
  const found = await findAdminById(row._id);
  assert.equal(String(found._id), String(row._id));
});

test('findAdminById returns null for a known inactive id', async () => {
  const row = await upsertAdminByEmail({ email: 'b@x.com' });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  assert.equal(await findAdminById(row._id), null);
});

test('findAdminById accepts a string or an ObjectId', async () => {
  const row = await upsertAdminByEmail({ email: 'c@x.com' });
  assert.ok(await findAdminById(row._id));            // ObjectId
  assert.ok(await findAdminById(row._id.toString())); // string
});

test('upsertAdminByEmail creates a row with defaults on first call', async () => {
  const row = await upsertAdminByEmail({ email: 'new@x.com' });
  assert.equal(row.role, 'admin');
  assert.equal(row.isActive, true);
  assert.ok(row.createdAt instanceof Date);
  assert.equal(row.lastLoginAt, null);
  assert.equal(row.notes, null);
  assert.equal(row.invitedByAdminUserId, null);
});

test('upsertAdminByEmail honors a provided role on insert', async () => {
  const row = await upsertAdminByEmail({ email: 'super@x.com', role: 'super_admin' });
  assert.equal(row.role, 'super_admin');
});

test('upsertAdminByEmail is idempotent — keeps the original createdAt', async () => {
  const first = await upsertAdminByEmail({ email: 'dup@x.com' });
  await new Promise((r) => setTimeout(r, 5));
  const second = await upsertAdminByEmail({ email: 'DUP@x.com', role: 'super_admin' });
  assert.equal(String(first._id), String(second._id));
  assert.equal(second.createdAt.getTime(), first.createdAt.getTime());
});

test('upsertAdminByEmail does NOT touch lastLoginAt or isActive on update', async () => {
  const row = await upsertAdminByEmail({ email: 'e@x.com' });
  await markAdminLoggedIn(row._id);
  const loggedIn = await findAdminById(row._id);
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: true } });
  const after = await upsertAdminByEmail({ email: 'e@x.com', notes: 'changed' });
  assert.equal(after.lastLoginAt.getTime(), loggedIn.lastLoginAt.getTime());
  assert.equal(after.isActive, true);
  assert.equal(after.notes, 'changed');
});

test('upsertAdminByEmail only writes role/notes/invitedBy when provided on update', async () => {
  const invitedBy = new ObjectId();
  await upsertAdminByEmail({ email: 'f@x.com', role: 'super_admin', notes: 'orig', invitedByAdminUserId: invitedBy });
  const after = await upsertAdminByEmail({ email: 'f@x.com' }); // provides nothing
  assert.equal(after.role, 'super_admin');            // untouched
  assert.equal(after.notes, 'orig');                  // untouched
  assert.equal(String(after.invitedByAdminUserId), String(invitedBy)); // untouched
});

test('markAdminLoggedIn sets lastLoginAt to a Date near now', async () => {
  const row = await upsertAdminByEmail({ email: 'g@x.com' });
  const before = Date.now();
  await markAdminLoggedIn(row._id);
  const found = await findAdminById(row._id);
  assert.ok(found.lastLoginAt instanceof Date);
  assert.ok(Math.abs(found.lastLoginAt.getTime() - before) < 5000);
});

test('ensureAdminUserIndexes creates a unique email index with collation strength 2', async () => {
  const indexes = await (await col('admin_users')).indexes();
  const emailIndex = indexes.find((i) => i.name === 'admin_users_email');
  assert.ok(emailIndex, 'email index exists');
  assert.equal(emailIndex.unique, true);
  assert.equal(emailIndex.collation.strength, 2);
});

// ---------------------------------------------------------------------------
// Team-management helpers (feat/admin-team-management chunk 1)
// ---------------------------------------------------------------------------

async function seedSuper(email = 'super@x.com') {
  return upsertAdminByEmail({ email, role: 'super_admin' });
}

test('listAdmins returns all rows, newest first', async () => {
  const a = await upsertAdminByEmail({ email: 'old@x.com' });
  await (await col('admin_users')).updateOne({ _id: a._id }, { $set: { createdAt: new Date(Date.now() - 60000) } });
  await upsertAdminByEmail({ email: 'new@x.com' });
  const rows = await listAdmins();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, 'new@x.com');
});

test('listAdmins includes inactive rows', async () => {
  const a = await upsertAdminByEmail({ email: 'gone@x.com' });
  await (await col('admin_users')).updateOne({ _id: a._id }, { $set: { isActive: false } });
  const rows = await listAdmins();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isActive, false);
});

test('findAdminByInviteToken returns row for valid non-expired token', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'inv@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  const found = await findAdminByInviteToken(row.inviteToken);
  assert.equal(found.email, 'inv@x.com');
});

test('findAdminByInviteToken returns null for expired token', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'inv@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await findAdminByInviteToken(row.inviteToken), null);
});

test('findAdminByInviteToken returns null for an already-active row', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'inv@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: true } });
  assert.equal(await findAdminByInviteToken(row.inviteToken), null);
});

test('createAdminInvite creates a pending row with all invite fields and isActive false', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'New@X.com', role: 'admin', invitedByAdminUserId: inviter._id });
  assert.equal(row.email, 'new@x.com');
  assert.equal(row.isActive, false);
  assert.match(row.inviteToken, /^[0-9a-f]{64}$/);
  assert.ok(row.inviteExpiresAt > new Date(Date.now() + 6 * 24 * 3600 * 1000));
  assert.equal(String(row.invitedByAdminUserId), String(inviter._id));
  assert.equal(row.activatedAt, null);
  assert.equal(row.lastLoginAt, null);
});

test('createAdminInvite on an existing INACTIVE row overwrites token, expiry, and role', async () => {
  const inviter = await seedSuper();
  const first = await createAdminInvite({ email: 'again@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  const second = await createAdminInvite({ email: 'again@x.com', role: 'super_admin', invitedByAdminUserId: inviter._id });
  assert.equal(String(second._id), String(first._id)); // same row (D4 — createdAt preserved)
  assert.notEqual(second.inviteToken, first.inviteToken);
  assert.equal(second.role, 'super_admin');
});

test('createAdminInvite on an existing ACTIVE row throws EMAIL_ALREADY_ADMIN', async () => {
  const inviter = await seedSuper();
  await upsertAdminByEmail({ email: 'active@x.com' });
  await assert.rejects(
    createAdminInvite({ email: 'active@x.com', role: 'admin', invitedByAdminUserId: inviter._id }),
    (err) => err.code === 'EMAIL_ALREADY_ADMIN',
  );
});

test('activateAdminByInviteToken activates, clears token fields, stamps activatedAt + lastLoginAt', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'join@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  const activated = await activateAdminByInviteToken(row.inviteToken, 'JOIN@x.com');
  assert.equal(activated.isActive, true);
  assert.equal(activated.inviteToken, undefined); // $unset, not null — sparse index safety
  assert.equal(activated.inviteExpiresAt, undefined);
  assert.ok(activated.activatedAt instanceof Date);
  assert.ok(activated.lastLoginAt instanceof Date);
});

test('activateAdminByInviteToken with wrong email throws INVITE_EMAIL_MISMATCH', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'join@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await assert.rejects(
    activateAdminByInviteToken(row.inviteToken, 'other@x.com'),
    (err) => err.code === 'INVITE_EMAIL_MISMATCH',
  );
});

test('activateAdminByInviteToken with expired token throws INVITE_INVALID', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'join@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(
    activateAdminByInviteToken(row.inviteToken, 'join@x.com'),
    (err) => err.code === 'INVITE_INVALID',
  );
});

test('deactivateAdmin blocks self-deactivation', async () => {
  const me = await seedSuper();
  await assert.rejects(
    deactivateAdmin(me._id, me._id.toString()),
    (err) => err.code === 'CANNOT_DEACTIVATE_SELF',
  );
});

test('deactivateAdmin blocks removing the last active super_admin', async () => {
  const only = await seedSuper();
  const acting = await upsertAdminByEmail({ email: 'plain@x.com', role: 'admin' });
  await assert.rejects(
    deactivateAdmin(only._id, acting._id.toString()),
    (err) => err.code === 'CANNOT_REMOVE_LAST_SUPER_ADMIN',
  );
});

test('deactivateAdmin succeeds when another active super_admin exists', async () => {
  const target = await seedSuper('s1@x.com');
  const other = await seedSuper('s2@x.com');
  const after = await deactivateAdmin(target._id, other._id.toString());
  assert.equal(after.isActive, false);
});

test('updateAdminRole blocks self-demotion', async () => {
  const me = await seedSuper();
  await assert.rejects(
    updateAdminRole(me._id, 'admin', me._id.toString()),
    (err) => err.code === 'CANNOT_DEMOTE_SELF',
  );
});

test('updateAdminRole blocks demoting the last active super_admin', async () => {
  const only = await seedSuper();
  const acting = await upsertAdminByEmail({ email: 'plain@x.com', role: 'admin' });
  await assert.rejects(
    updateAdminRole(only._id, 'admin', acting._id.toString()),
    (err) => err.code === 'CANNOT_DEMOTE_LAST_SUPER_ADMIN',
  );
});

test('updateAdminRole promotes admin to super_admin', async () => {
  const acting = await seedSuper();
  const target = await upsertAdminByEmail({ email: 'up@x.com', role: 'admin' });
  const after = await updateAdminRole(target._id, 'super_admin', acting._id.toString());
  assert.equal(after.role, 'super_admin');
});

test('updateAdminRole rejects an invalid role string', async () => {
  const acting = await seedSuper();
  const target = await upsertAdminByEmail({ email: 'up@x.com', role: 'admin' });
  await assert.rejects(
    updateAdminRole(target._id, 'viewer', acting._id.toString()),
    (err) => err.code === 'INVALID_ROLE',
  );
});

test('resendAdminInvite regenerates token AND expiry', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'p@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { inviteExpiresAt: new Date(Date.now() + 1000) } });
  const resent = await resendAdminInvite(row._id);
  assert.notEqual(resent.inviteToken, row.inviteToken);
  assert.match(resent.inviteToken, /^[0-9a-f]{64}$/);
  assert.ok(resent.inviteExpiresAt > new Date(Date.now() + 6 * 24 * 3600 * 1000));
});

test('resendAdminInvite preserves email, role, invitedBy, createdAt', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'p@x.com', role: 'super_admin', invitedByAdminUserId: inviter._id });
  const resent = await resendAdminInvite(row._id);
  assert.equal(resent.email, 'p@x.com');
  assert.equal(resent.role, 'super_admin');
  assert.equal(String(resent.invitedByAdminUserId), String(inviter._id));
  assert.equal(resent.createdAt.getTime(), row.createdAt.getTime());
});

test('resendAdminInvite throws for an active admin', async () => {
  const row = await seedSuper('active@x.com');
  await assert.rejects(resendAdminInvite(row._id), (err) => err.code === 'CANNOT_RESEND_ACTIVE_ADMIN');
});

test('resendAdminInvite throws for an ever-activated (now inactive) admin', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'was@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await activateAdminByInviteToken(row.inviteToken, 'was@x.com');
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  await assert.rejects(resendAdminInvite(row._id), (err) => err.code === 'CANNOT_RESEND_ACTIVATED_ADMIN');
});

test('resendAdminInvite throws NOT_FOUND for an unknown id', async () => {
  await assert.rejects(resendAdminInvite(new ObjectId().toString()), (err) => err.code === 'NOT_FOUND');
});

test('revokeAdminInvite deletes the pending row', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'p@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  const result = await revokeAdminInvite(row._id);
  assert.equal(result.adminUserId, row._id.toString());
  assert.equal(await (await col('admin_users')).findOne({ _id: row._id }), null);
});

test('revokeAdminInvite throws for an active admin', async () => {
  const row = await seedSuper('active@x.com');
  await assert.rejects(revokeAdminInvite(row._id), (err) => err.code === 'CANNOT_REVOKE_ACTIVE_ADMIN');
});

test('revokeAdminInvite throws for an ever-activated (now inactive) admin', async () => {
  const inviter = await seedSuper();
  const row = await createAdminInvite({ email: 'was@x.com', role: 'admin', invitedByAdminUserId: inviter._id });
  await activateAdminByInviteToken(row.inviteToken, 'was@x.com');
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  await assert.rejects(revokeAdminInvite(row._id), (err) => err.code === 'CANNOT_REVOKE_ACTIVATED_ADMIN');
});

test('revokeAdminInvite throws NOT_FOUND for an unknown id', async () => {
  await assert.rejects(revokeAdminInvite(new ObjectId().toString()), (err) => err.code === 'NOT_FOUND');
});

test('resend/revoke refuse a deactivated BOOTSTRAP admin (no invite token, activatedAt null)', async () => {
  const row = await upsertAdminByEmail({ email: 'boot@x.com', role: 'admin' }); // bootstrap: no invite fields
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  await assert.rejects(resendAdminInvite(row._id), (err) => err.code === 'CANNOT_RESEND_ACTIVATED_ADMIN');
  await assert.rejects(revokeAdminInvite(row._id), (err) => err.code === 'CANNOT_REVOKE_ACTIVATED_ADMIN');
});

test('ensureAdminUserIndexes creates the sparse unique inviteToken index', async () => {
  const indexes = await (await col('admin_users')).indexes();
  const tokenIndex = indexes.find((i) => i.name === 'admin_users_invite_token');
  assert.ok(tokenIndex, 'invite token index exists');
  assert.equal(tokenIndex.unique, true);
  assert.equal(tokenIndex.sparse, true);
});
