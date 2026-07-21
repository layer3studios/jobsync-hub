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
