// FILE: tests/models/assignment-submission-model.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  MAX_SUBMISSION_LINKS, MAX_SUBMISSION_FILES, ensureAssignmentSubmissionIndexes,
  buildAssignmentSnapshot, insertAssignmentSubmission,
  getAssignmentSubmissionForApplication, getAssignmentSubmissionForCompany,
  listAssignmentSubmissionsForApplications, markSubmissionFilesDeleted,
  toPublicAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';

const companyA = new ObjectId();
const companyB = new ObjectId();
const jobId = new ObjectId();

function file(n) {
  return {
    fileId: new ObjectId(), originalName: `answer-${n}.pdf`,
    storagePath: `/var/data/assignments/answer-${n}.pdf`,
    sizeBytes: 1024, mimeType: 'application/pdf', uploadedAt: new Date(),
  };
}
function link(n) { return { url: `https://example.com/${n}`, addedAt: new Date() }; }

function input(overrides = {}) {
  return {
    applicationId: new ObjectId(), companyId: companyA, jobId,
    assignmentSnapshot: buildAssignmentSnapshot({ _id: new ObjectId(), title: 'Task', estimatedHours: 3 }),
    links: [link(1)], files: [file(1)], seekerNotesMarkdown: 'Here you go.',
    ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignment_submissions');
  await ensureAssignmentSubmissionIndexes();
}

test('ensureAssignmentSubmissionIndexes creates both expected indexes', async () => {
  const db = await connectTestDb();
  const names = (await db.collection('assignment_submissions').indexes()).map((i) => i.name);
  assert.ok(names.includes('assignment_submissions_applicationId'));
  assert.ok(names.includes('assignment_submissions_company_job_submittedAt'));
});

test('buildAssignmentSnapshot is pure — no DB, id from _id, snapshottedAt from the injected now', () => {
  const sourceId = new ObjectId();
  const now = new Date('2026-01-02T03:04:05.000Z');
  const snapshot = buildAssignmentSnapshot({
    _id: sourceId, title: 'Rate limiter', publicSummary: 'Small task',
    descriptionMarkdown: '## Do it', submissionInstructionsMarkdown: 'Send a link',
    estimatedHours: 4, allowedFileTypes: ['pdf', 'zip'], companyId: companyA,
  }, now);

  assert.equal(snapshot.title, 'Rate limiter');
  assert.equal(snapshot.publicSummary, 'Small task');
  assert.equal(snapshot.descriptionMarkdown, '## Do it');
  assert.equal(snapshot.submissionInstructionsMarkdown, 'Send a link');
  assert.equal(snapshot.estimatedHours, 4);
  assert.deepEqual(snapshot.allowedFileTypes, ['pdf', 'zip']);
  assert.equal(snapshot.sourceAssignmentId.toString(), sourceId.toString());
  assert.equal(snapshot.snapshottedAt.getTime(), now.getTime());
  assert.equal(snapshot.companyId, undefined); // only the snapshot fields, nothing else
});

test('insertAssignmentSubmission happy path; profileLinks normalized to both-null when omitted', async () => {
  const doc = await insertAssignmentSubmission(input());
  assert.ok(doc._id);
  assert.deepEqual(doc.profileLinks, { githubUrl: null, linkedinUrl: null });
  assert.equal(doc.filesDeletedAt, null);
  assert.ok(doc.submittedAt instanceof Date);
  const withLinks = await insertAssignmentSubmission(input({ profileLinks: { githubUrl: 'https://github.com/x' } }));
  assert.deepEqual(withLinks.profileLinks, { githubUrl: 'https://github.com/x', linkedinUrl: null });
});

test('insertAssignmentSubmission throws on each missing required id', async () => {
  await assert.rejects(() => insertAssignmentSubmission(input({ applicationId: null })));
  await assert.rejects(() => insertAssignmentSubmission(input({ companyId: 'nope' })));
  await assert.rejects(() => insertAssignmentSubmission(input({ jobId: null })));
});

test('exactly 5 links and 5 files accepted; 6 of either throws', async () => {
  const five = await insertAssignmentSubmission(input({
    links: [1, 2, 3, 4, 5].map(link), files: [1, 2, 3, 4, 5].map(file),
  }));
  assert.equal(five.links.length, MAX_SUBMISSION_LINKS);
  assert.equal(five.files.length, MAX_SUBMISSION_FILES);
  await assert.rejects(() => insertAssignmentSubmission(input({ links: [1, 2, 3, 4, 5, 6].map(link) })));
  await assert.rejects(() => insertAssignmentSubmission(input({ files: [1, 2, 3, 4, 5, 6].map(file) })));
});

test('a duplicate applicationId surfaces as E11000 (not swallowed)', async () => {
  const applicationId = new ObjectId();
  await insertAssignmentSubmission(input({ applicationId }));
  await assert.rejects(
    () => insertAssignmentSubmission(input({ applicationId })),
    (err) => err.code === 11000,
  );
});

test('toPublicAssignmentSubmission never exposes storagePath on any file', async () => {
  const doc = await insertAssignmentSubmission(input({ files: [1, 2, 3].map(file) }));
  const publicDoc = toPublicAssignmentSubmission(doc);
  assert.equal(publicDoc.files.length, 3);
  for (const entry of publicDoc.files) {
    assert.equal(entry.storagePath, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(entry, 'storagePath'));
    assert.ok(entry.originalName);
  }
  assert.ok(!JSON.stringify(publicDoc).includes('/var/data/assignments'));
  assert.equal(publicDoc.companyId, undefined);
});

test('cross-tenant: getAssignmentSubmissionForCompany with another company returns null', async () => {
  const doc = await insertAssignmentSubmission(input());
  assert.ok(await getAssignmentSubmissionForCompany(companyA, doc._id));
  assert.equal(await getAssignmentSubmissionForCompany(companyB, doc._id), null);
});

test('getAssignmentSubmissionForApplication finds by applicationId', async () => {
  const applicationId = new ObjectId();
  await insertAssignmentSubmission(input({ applicationId }));
  const found = await getAssignmentSubmissionForApplication(applicationId);
  assert.equal(found.applicationId.toString(), applicationId.toString());
  assert.equal(await getAssignmentSubmissionForApplication(new ObjectId()), null);
});

test('listAssignmentSubmissionsForApplications: [] for an empty list, filtered by companyId', async () => {
  const appA = new ObjectId();
  const appB = new ObjectId();
  await insertAssignmentSubmission(input({ applicationId: appA }));
  await insertAssignmentSubmission(input({ applicationId: appB, companyId: companyB }));

  assert.deepEqual(await listAssignmentSubmissionsForApplications(companyA, []), []);
  const mine = await listAssignmentSubmissionsForApplications(companyA, [appA, appB]);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].applicationId.toString(), appA.toString());
});

test('markSubmissionFilesDeleted stamps the tombstone and empties files', async () => {
  const doc = await insertAssignmentSubmission(input({ files: [1, 2].map(file) }));
  const updated = await markSubmissionFilesDeleted(companyA, doc._id);
  assert.ok(updated.filesDeletedAt instanceof Date);
  assert.deepEqual(updated.files, []);
  assert.equal(await markSubmissionFilesDeleted(companyB, doc._id), null);
});
