// FILE: tests/services/applicant-notes-service.test.js
// Note create/list service — body validation (C7), the tenant assertion (C6), and the
// author snapshot (D7/R2). Seeds applications + employer_users directly; the service is
// the unit under test, so no HTTP layer is involved.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  createApplicantNoteForApplicant, listApplicantNotesForApplicant,
} from '../../src/services/employer/applicant-notes-service.js';

const COMPANY_ID = new ObjectId();
const OTHER_COMPANY = new ObjectId();
const APP_ID = new ObjectId();
const OTHER_APP_ID = new ObjectId();
const AUTHOR_ID = new ObjectId();

/** Assert a thrown HttpError carries the expected status + code. */
function rejectsWith(status, code) {
  return (err) => { assert.equal(err.status, status); assert.equal(err.code, code); return true; };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('applications', 'applicant_notes', 'employer_users');
  await (await col('applications')).insertMany([
    { _id: APP_ID, companyId: COMPANY_ID, stageId: new ObjectId(), contactId: new ObjectId(), jobId: new ObjectId(), archived: null },
    // Belongs to ANOTHER company — the cross-tenant fixture.
    { _id: OTHER_APP_ID, companyId: OTHER_COMPANY, stageId: new ObjectId(), contactId: new ObjectId(), jobId: new ObjectId(), archived: null },
  ]);
  await (await col('employer_users')).insertOne({
    _id: AUTHOR_ID, googleId: 'g-author', email: 'owner@acme.com', name: 'Ada Owner', companyId: COMPANY_ID,
  });
}

test('createApplicantNoteForApplicant validates body length: empty rejected', async () => {
  await assert.rejects(
    () => createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, '   '),
    rejectsWith(400, 'INVALID_NOTE_BODY'),
  );
  await assert.rejects(
    () => createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, undefined),
    rejectsWith(400, 'INVALID_NOTE_BODY'),
  );
});

test('createApplicantNoteForApplicant accepts a body of exactly 4000 characters', async () => {
  const note = await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'x'.repeat(4000));
  assert.equal(note.body.length, 4000);
});

test('createApplicantNoteForApplicant rejects a body of 4001 characters', async () => {
  await assert.rejects(
    () => createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'x'.repeat(4001)),
    rejectsWith(400, 'INVALID_NOTE_BODY'),
  );
});

test('rejects "<script" case-insensitively in the body', async () => {
  for (const body of ['<script>alert(1)</script>', 'ok then <ScRiPt src=x>']) {
    await assert.rejects(
      () => createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, body),
      rejectsWith(400, 'INVALID_NOTE_BODY'),
    );
  }
});

test('strips control characters (except tab and newline) before the length check', async () => {
  const note = await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'a\x00b\x07c\td\ne');
  assert.equal(note.body, 'abc\td\ne'); // NUL + BEL gone; tab + newline survive
  // Stripping happens BEFORE the length check, so control chars cannot buy extra length:
  // 4000 real chars padded with control bytes cleans down to exactly 4000 and is accepted.
  const padded = await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, `${'y'.repeat(4000)}\x00\x07`);
  assert.equal(padded.body.length, 4000);
  // ...and a body of ONLY control characters is empty once cleaned.
  await assert.rejects(
    () => createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, '\x00\x07\x1F'),
    rejectsWith(400, 'INVALID_NOTE_BODY'),
  );
});

test('asserts application.companyId matches the passed companyId — cross-tenant throws', async () => {
  await assert.rejects(
    () => createApplicantNoteForApplicant(COMPANY_ID, OTHER_APP_ID, AUTHOR_ID, 'sneaky'),
    rejectsWith(404, 'APPLICATION_NOT_FOUND'),
  );
  assert.equal(await (await col('applicant_notes')).countDocuments({}), 0); // nothing written
});

test("loads the author's name and email from employer_users and denormalizes them", async () => {
  const note = await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'Strong on backend.');
  assert.equal(note.authorName, 'Ada Owner');
  assert.equal(note.authorEmail, 'owner@acme.com');
  assert.equal(note.authorEmployerUserId, AUTHOR_ID.toString());
  const stored = await (await col('applicant_notes')).findOne({});
  assert.equal(stored.authorName, 'Ada Owner');
  assert.equal(stored.companyId.toString(), COMPANY_ID.toString());
});

test('missing author (employer user not found) → throws 401 and writes nothing', async () => {
  await assert.rejects(
    () => createApplicantNoteForApplicant(COMPANY_ID, APP_ID, new ObjectId(), 'orphan note'),
    rejectsWith(401, 'AUTHOR_NOT_FOUND'),
  );
  assert.equal(await (await col('applicant_notes')).countDocuments({}), 0);
});

test('author snapshot is immutable history — renaming the employer user does not rewrite past notes', async () => {
  const note = await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'written as Ada');
  assert.equal(note.authorName, 'Ada Owner');
  // The source-of-truth user record changes AFTER the note was written (R2).
  await (await col('employer_users')).updateOne({ _id: AUTHOR_ID }, { $set: { name: 'Ada Renamed' } });
  const [listed] = await listApplicantNotesForApplicant(COMPANY_ID, APP_ID);
  assert.equal(listed.authorName, 'Ada Owner'); // name-at-time-of-write survives
});

test('listApplicantNotesForApplicant returns the model result in client shape, newest first', async () => {
  assert.deepEqual(await listApplicantNotesForApplicant(COMPANY_ID, APP_ID), []);
  await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'first');
  await createApplicantNoteForApplicant(COMPANY_ID, APP_ID, AUTHOR_ID, 'second');
  const notes = await listApplicantNotesForApplicant(COMPANY_ID, APP_ID);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].body, 'second');
  assert.equal(typeof notes[0].id, 'string');
  assert.equal(notes[0].companyId, undefined);
  // A cross-tenant read of the same application returns nothing.
  assert.deepEqual(await listApplicantNotesForApplicant(OTHER_COMPANY, APP_ID), []);
});
