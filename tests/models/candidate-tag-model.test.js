// FILE: tests/models/candidate-tag-model.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureCandidateTagIndexes, createTag, listTags, deleteTag, resolveTagNames, normalizeTagName,
} from '../../src/models/employer/candidate-tag-model.js';

const reset = async () => {
  await dropCollections('candidate_tags', 'applications');
  await ensureCandidateTagIndexes();
};

before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('normalizeTagName lowercases, trims and collapses whitespace', () => {
  assert.equal(normalizeTagName('  Referral  '), 'referral');
  assert.equal(normalizeTagName('Strong   Hire'), 'strong hire');
  assert.equal(normalizeTagName('x'.repeat(40)).length, 30);
  assert.equal(normalizeTagName(42), '');
});

test('createTag returns the existing row for a duplicate, whatever the casing', async () => {
  const companyId = new ObjectId();
  const first = await createTag(companyId, 'Referral');
  const second = await createTag(companyId, '  referral ');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.tag._id.toString(), first.tag._id.toString());
  assert.equal((await listTags(companyId)).length, 1);
});

test('the same name in two companies is two separate tags', async () => {
  const companyA = new ObjectId();
  const companyB = new ObjectId();
  await createTag(companyA, 'referral');
  await createTag(companyB, 'referral');
  assert.equal((await listTags(companyA)).length, 1);
  assert.equal((await listTags(companyB)).length, 1);
});

test('listTags is alphabetical and company-scoped', async () => {
  const companyId = new ObjectId();
  for (const name of ['zeta', 'alpha', 'mid']) await createTag(companyId, name);
  assert.deepEqual((await listTags(companyId)).map((tag) => tag.name), ['alpha', 'mid', 'zeta']);
  assert.deepEqual(await listTags(new ObjectId()), []);
});

test('deleteTag removes the tag from every application carrying it', async () => {
  const companyId = new ObjectId();
  const { tag } = await createTag(companyId, 'referral');
  const applications = await col('applications');
  await applications.insertMany([
    { companyId, tags: ['referral', 'strong'] },
    { companyId, tags: ['strong'] },
    { companyId: new ObjectId(), tags: ['referral'] }, // another tenant — untouched
  ]);

  const result = await deleteTag(companyId, tag._id);
  assert.equal(result.deleted, true);
  assert.equal(result.applicationsUpdated, 1);
  assert.equal((await listTags(companyId)).length, 0);

  const mine = await applications.find({ companyId }).toArray();
  assert.deepEqual(mine[0].tags, ['strong']);
  const theirs = await applications.findOne({ companyId: { $ne: companyId } });
  assert.deepEqual(theirs.tags, ['referral']);
});

test('deleteTag refuses a tag belonging to another company', async () => {
  const companyId = new ObjectId();
  const { tag } = await createTag(companyId, 'referral');
  assert.deepEqual(await deleteTag(new ObjectId(), tag._id), { deleted: false, applicationsUpdated: 0 });
});

test('resolveTagNames canonicalizes, dedupes and refuses unknown names', async () => {
  const companyId = new ObjectId();
  await createTag(companyId, 'referral');
  await createTag(companyId, 'strong');

  assert.deepEqual(await resolveTagNames(companyId, ['Referral', 'referral', 'STRONG']), ['referral', 'strong']);
  assert.deepEqual(await resolveTagNames(companyId, []), []);
  await assert.rejects(() => resolveTagNames(companyId, ['nope']), /Unknown tag/);
  await assert.rejects(() => resolveTagNames(companyId, 'referral'), /must be an array/);
});

test('resolveTagNames enforces the 10-tag cap', async () => {
  const companyId = new ObjectId();
  const names = Array.from({ length: 11 }, (_, index) => `tag${index}`);
  for (const name of names) await createTag(companyId, name);
  await assert.rejects(() => resolveTagNames(companyId, names), /up to 10 tags/);
});
