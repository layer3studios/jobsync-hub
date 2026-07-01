import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureContactIndexes, findOrCreateContactForCompany, getContactForCompany,
} from '../../src/models/public/contact-model.js';

const COMPANY_A = new ObjectId();
const COMPANY_B = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('contacts');
  await ensureContactIndexes();
}

test('findOrCreateContact: new → isNew true; repeat → isNew false, same id', async () => {
  const first = await findOrCreateContactForCompany(COMPANY_A, { email: 'A@X.com', fullName: 'Asha' });
  assert.equal(first.isNew, true);
  const second = await findOrCreateContactForCompany(COMPANY_A, { email: 'a@x.com', fullName: 'Asha Rao' });
  assert.equal(second.isNew, false);
  assert.equal(second.contact._id.toString(), first.contact._id.toString());
});

test('email is normalized to lowercase on create', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'MixedCase@X.com' });
  assert.equal(contact.email, 'mixedcase@x.com');
});

test('same email across companies → separate contacts', async () => {
  const a = await findOrCreateContactForCompany(COMPANY_A, { email: 'shared@x.com' });
  const b = await findOrCreateContactForCompany(COMPANY_B, { email: 'shared@x.com' });
  assert.notEqual(a.contact._id.toString(), b.contact._id.toString());
});

test('duplicate (companyId, email) direct insert violates the unique index', async () => {
  await findOrCreateContactForCompany(COMPANY_A, { email: 'dup@x.com' });
  const contacts = await col('contacts');
  await assert.rejects(
    () => contacts.insertOne({ companyId: COMPANY_A, email: 'dup@x.com', createdAt: new Date() }),
    (err) => { assert.equal(err.code, 11000); return true; },
  );
});

test('getContactForCompany is cross-tenant safe', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'scoped@x.com' });
  assert.ok(await getContactForCompany(COMPANY_A, contact._id));
  assert.equal(await getContactForCompany(COMPANY_B, contact._id), null);
});
