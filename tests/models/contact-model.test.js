import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureContactIndexes, findOrCreateContactForCompany, getContactForCompany,
  mergeContactEnrichmentForCompany, toPublicContact,
} from '../../src/models/public/contact-model.js';

const FULL_ENRICHMENT = {
  linkedinUrl: 'https://www.linkedin.com/in/asha-rao',
  githubUrl: 'https://github.com/asharao',
  portfolioUrl: 'https://asha.dev',
  location: 'Bangalore, India',
};

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

// ─── Resume enrichment merge (Chunk 2) ────────────────────────────────

test('mergeContactEnrichment fills a currently-null field', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'fill@x.com' });
  const merged = await mergeContactEnrichmentForCompany(COMPANY_A, contact._id, FULL_ENRICHMENT);
  assert.equal(merged.linkedinUrl, 'https://www.linkedin.com/in/asha-rao');
  assert.equal(merged.githubUrl, 'https://github.com/asharao');
  assert.equal(merged.portfolioUrl, 'https://asha.dev');
  assert.equal(merged.location, 'Bangalore, India');
});

test('mergeContactEnrichment does NOT overwrite a currently non-null field', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, {
    email: 'keep@x.com', linkedinUrl: 'https://linkedin.com/in/original', location: 'Pune',
  });
  const merged = await mergeContactEnrichmentForCompany(COMPANY_A, contact._id, FULL_ENRICHMENT);
  assert.equal(merged.linkedinUrl, 'https://linkedin.com/in/original', 'existing value preserved');
  assert.equal(merged.location, 'Pune', 'existing value preserved');
  assert.equal(merged.githubUrl, 'https://github.com/asharao', 'null field still filled');
});

test('mergeContactEnrichment treats a currently empty/whitespace field as null and fills it', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, {
    email: 'empty@x.com', linkedinUrl: '', location: '   ',
  });
  const merged = await mergeContactEnrichmentForCompany(COMPANY_A, contact._id, FULL_ENRICHMENT);
  assert.equal(merged.linkedinUrl, 'https://www.linkedin.com/in/asha-rao');
  assert.equal(merged.location, 'Bangalore, India');
});

test('mergeContactEnrichment treats an incoming empty/whitespace value as null (no overwrite)', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, {
    email: 'incoming@x.com', linkedinUrl: 'https://linkedin.com/in/keep',
  });
  const merged = await mergeContactEnrichmentForCompany(COMPANY_A, contact._id, {
    linkedinUrl: '   ', githubUrl: '', portfolioUrl: '', location: '  ',
  });
  assert.equal(merged.linkedinUrl, 'https://linkedin.com/in/keep', 'not overwritten by an empty string');
  assert.equal(merged.githubUrl, null);
  assert.equal(merged.portfolioUrl, null);
  assert.equal(merged.location, null);
});

test('mergeContactEnrichment is cross-tenant safe — returns null, writes nothing', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'tenant@x.com' });
  assert.equal(await mergeContactEnrichmentForCompany(COMPANY_B, contact._id, FULL_ENRICHMENT), null);
  const untouched = await getContactForCompany(COMPANY_A, contact._id);
  assert.equal(untouched.linkedinUrl, null);
  assert.equal(untouched.githubUrl, null);
});

test('mergeContactEnrichment with all-null incoming returns the contact and skips the write', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'noop@x.com' });
  const before = await getContactForCompany(COMPANY_A, contact._id);
  const merged = await mergeContactEnrichmentForCompany(COMPANY_A, contact._id, {
    linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null,
  });
  assert.equal(merged._id.toString(), before._id.toString());
  // $currentDate would have bumped updatedAt had a write been issued.
  assert.equal(merged.updatedAt.getTime(), before.updatedAt.getTime());
});

test('mergeContactEnrichment re-validates its input: bad URLs dropped, long location truncated', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'guard@x.com' });
  const merged = await mergeContactEnrichmentForCompany(COMPANY_A, contact._id, {
    linkedinUrl: 'https://github.com/not-linkedin', // wrong host
    githubUrl: 'github.com/asharao',                // no scheme
    portfolioUrl: 'not a url',
    location: 'x'.repeat(250),
  });
  assert.equal(merged.linkedinUrl, null);
  assert.equal(merged.githubUrl, null);
  assert.equal(merged.portfolioUrl, null);
  assert.equal(merged.location.length, 200);
});

test('toPublicContact returns githubUrl and portfolioUrl, null when the doc lacks them', async () => {
  const { contact } = await findOrCreateContactForCompany(COMPANY_A, { email: 'shape@x.com' });
  const shaped = toPublicContact(contact);
  assert.equal(shaped.githubUrl, null);
  assert.equal(shaped.portfolioUrl, null);
  // A legacy contact doc predating this change carries neither field at all.
  const legacy = toPublicContact({ _id: new ObjectId(), email: 'legacy@x.com', firstSeenAt: new Date() });
  assert.equal(legacy.githubUrl, null);
  assert.equal(legacy.portfolioUrl, null);
});
