// FILE: tests/models/assignment-model.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ALLOWED_FILE_TYPES, ensureAssignmentIndexes, insertAssignment,
  listAssignmentsForCompany, getAssignmentForCompany, updateAssignmentForCompany,
  archiveAssignmentForCompany, unarchiveAssignmentForCompany,
  countJobsUsingAssignment, listJobTitlesUsingAssignment, toPublicAssignment,
} from '../../src/models/employer/assignment-model.js';

const companyA = new ObjectId();
const companyB = new ObjectId();

function input(overrides = {}) {
  return {
    companyId: companyA,
    title: 'Build a rate limiter',
    publicSummary: 'A small backend exercise.',
    descriptionMarkdown: '## Task\nBuild it.',
    estimatedHours: 4,
    submissionInstructionsMarkdown: 'Send a repo link.',
    allowedFileTypes: ['pdf'],
    createdByEmployerUserId: new ObjectId(),
    ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignments', 'jobs');
  await ensureAssignmentIndexes();
}

test('ensureAssignmentIndexes creates assignments_companyId_archivedAt', async () => {
  const db = await connectTestDb();
  const names = (await db.collection('assignments').indexes()).map((i) => i.name);
  assert.ok(names.includes('assignments_companyId_archivedAt'));
});

test('insertAssignment happy path — archivedAt null, Date timestamps', async () => {
  const doc = await insertAssignment(input());
  assert.ok(doc._id);
  assert.equal(doc.archivedAt, null);
  assert.equal(doc.estimatedHours, 4);
  assert.deepEqual(doc.allowedFileTypes, ['pdf']);
  assert.ok(doc.createdAt instanceof Date);
  assert.ok(doc.updatedAt instanceof Date);
  assert.equal(toPublicAssignment(doc).id, doc._id.toString());
});

test('insertAssignment throws on a missing or invalid companyId', async () => {
  await assert.rejects(() => insertAssignment(input({ companyId: null })));
  await assert.rejects(() => insertAssignment(input({ companyId: 'not-an-id' })));
});

test('allowedFileTypes: [] accepted, duplicates deduped, non-array → [], unknown throws', async () => {
  assert.deepEqual((await insertAssignment(input({ allowedFileTypes: [] }))).allowedFileTypes, []);
  assert.deepEqual(
    (await insertAssignment(input({ allowedFileTypes: ['pdf', 'pdf', 'zip'] }))).allowedFileTypes,
    ['pdf', 'zip'],
  );
  assert.deepEqual((await insertAssignment(input({ allowedFileTypes: 'pdf' }))).allowedFileTypes, []);
  assert.deepEqual((await insertAssignment(input({ allowedFileTypes: undefined }))).allowedFileTypes, []);
  await assert.rejects(() => insertAssignment(input({ allowedFileTypes: ['exe'] })));
  assert.deepEqual([...ALLOWED_FILE_TYPES], ['pdf', 'zip', 'md']);
});

test('estimatedHours 0, 9, 2.5 and "2" all throw', async () => {
  for (const bad of [0, 9, 2.5, '2']) {
    await assert.rejects(() => insertAssignment(input({ estimatedHours: bad })), `expected ${bad} to throw`);
  }
});

test('listAssignmentsForCompany excludes archived by default, includes with the flag', async () => {
  const live = await insertAssignment(input());
  const gone = await insertAssignment(input({ title: 'Old one' }));
  await archiveAssignmentForCompany(companyA, gone._id);
  const visible = await listAssignmentsForCompany(companyA);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]._id.toString(), live._id.toString());
  assert.equal((await listAssignmentsForCompany(companyA, { includeArchived: true })).length, 2);
});

test('cross-tenant: getAssignmentForCompany with another company returns null', async () => {
  const doc = await insertAssignment(input());
  assert.ok(await getAssignmentForCompany(companyA, doc._id));
  assert.equal(await getAssignmentForCompany(companyB, doc._id), null);
  assert.equal(await getAssignmentForCompany(companyA, 'not-an-id'), null);
});

test('cross-tenant: updateAssignmentForCompany with another company returns null and mutates nothing', async () => {
  const doc = await insertAssignment(input());
  assert.equal(await updateAssignmentForCompany(companyB, doc._id, { title: 'Hijacked' }), null);
  const stored = await getAssignmentForCompany(companyA, doc._id);
  assert.equal(stored.title, 'Build a rate limiter');
});

test('updateAssignmentForCompany bumps updatedAt, re-validates, and cannot change companyId', async () => {
  const doc = await insertAssignment(input());
  const updated = await updateAssignmentForCompany(companyA, doc._id, {
    title: 'Renamed', companyId: companyB, _id: new ObjectId(), allowedFileTypes: ['zip', 'zip'],
  });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.companyId.toString(), companyA.toString());
  assert.equal(updated._id.toString(), doc._id.toString());
  assert.deepEqual(updated.allowedFileTypes, ['zip']);
  assert.ok(updated.updatedAt.getTime() >= doc.updatedAt.getTime());
  await assert.rejects(() => updateAssignmentForCompany(companyA, doc._id, { estimatedHours: 99 }));
  await assert.rejects(() => updateAssignmentForCompany(companyA, doc._id, { allowedFileTypes: ['exe'] }));
});

test('archive is idempotent; unarchive clears archivedAt', async () => {
  const doc = await insertAssignment(input());
  const archived = await archiveAssignmentForCompany(companyA, doc._id);
  assert.ok(archived.archivedAt instanceof Date);
  const again = await archiveAssignmentForCompany(companyA, doc._id);
  assert.equal(again.archivedAt.getTime(), archived.archivedAt.getTime());
  const restored = await unarchiveAssignmentForCompany(companyA, doc._id);
  assert.equal(restored.archivedAt, null);
});

test('countJobsUsingAssignment counts native postings only — a scraped job with the same assignmentId is ignored', async () => {
  const assignment = await insertAssignment(input());
  const jobs = await col('jobs');
  await jobs.insertMany([
    { source: 'native', companyId: companyA, assignmentId: assignment._id, title: 'Backend Engineer', status: 'active' },
    { source: 'native', companyId: companyA, assignmentId: assignment._id, title: 'Platform Engineer', status: 'draft' },
    { source: 'native', companyId: companyB, assignmentId: assignment._id, title: 'Other Tenant', status: 'active' },
    // A scraped ATS row: PascalCase fields, no `source`, no companyId.
    { JobID: 'ats-1', Title: 'Scraped Role', assignmentId: assignment._id },
  ]);

  assert.equal(await countJobsUsingAssignment(companyA, assignment._id), 2);
  const titles = await listJobTitlesUsingAssignment(companyA, assignment._id);
  assert.equal(titles.length, 2);
  assert.deepEqual(titles.map((t) => t.title).sort(), ['Backend Engineer', 'Platform Engineer']);
  assert.ok(titles.every((t) => typeof t.id === 'string' && t.status));
  assert.ok(!titles.some((t) => t.title === 'Scraped Role'));
});

test('usage reads return empty/zero for another tenant and for bad ids', async () => {
  const assignment = await insertAssignment(input());
  assert.equal(await countJobsUsingAssignment(companyB, assignment._id), 0);
  assert.deepEqual(await listJobTitlesUsingAssignment(companyA, 'not-an-id'), []);
});
