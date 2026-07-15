// FILE: tests/models/applicant-note-model.test.js
// applicant_notes model — append-only per-application notes. Covers the companyId
// scoping of the read path (§6.5), newest-first ordering, the default limit, and
// idempotent index setup.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb, connectTestDb } from '../_helpers/test-db.js';
import {
  ensureApplicantNoteIndexes, createApplicantNote,
  listApplicantNotesForApplication, toPublicApplicantNote,
} from '../../src/models/public/applicant-note-model.js';

const COMPANY_ID = new ObjectId();
const OTHER_COMPANY = new ObjectId();
const APP_ID = new ObjectId();
const AUTHOR_ID = new ObjectId();

/** A note on APP_ID for COMPANY_ID unless overridden. */
function noteInput(overrides = {}) {
  return {
    companyId: COMPANY_ID,
    applicationId: APP_ID,
    authorEmployerUserId: AUTHOR_ID,
    authorName: 'Owner',
    authorEmail: 'owner@acme.com',
    body: 'Strong on backend.',
    ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('applicant_notes');
  await ensureApplicantNoteIndexes();
}

test('createApplicantNote inserts a doc with all required fields', async () => {
  const note = await createApplicantNote(noteInput());
  assert.ok(note._id);
  assert.equal(note.companyId.toString(), COMPANY_ID.toString());
  assert.equal(note.applicationId.toString(), APP_ID.toString());
  assert.equal(note.authorEmployerUserId.toString(), AUTHOR_ID.toString());
  assert.equal(note.authorName, 'Owner');
  assert.equal(note.authorEmail, 'owner@acme.com');
  assert.equal(note.body, 'Strong on backend.');
  assert.ok(note.createdAt instanceof Date);
  // updatedAt equals createdAt on insert (D1) — append-only, so it never diverges.
  assert.equal(note.updatedAt.getTime(), note.createdAt.getTime());
});

test('listApplicantNotesForApplication returns notes for one application, newest first', async () => {
  await createApplicantNote(noteInput({ body: 'older', createdAt: new Date('2026-01-01') }));
  await createApplicantNote(noteInput({ body: 'newer', createdAt: new Date('2026-02-01') }));
  // A note on a DIFFERENT application in the same company must not leak in.
  await createApplicantNote(noteInput({ applicationId: new ObjectId(), body: 'other application' }));

  const list = await listApplicantNotesForApplication(COMPANY_ID, APP_ID);
  assert.equal(list.length, 2);
  assert.equal(list[0].body, 'newer');
  assert.equal(list[1].body, 'older');
  assert.ok(list[0].createdAt > list[1].createdAt);
});

test('listApplicantNotesForApplication filters by companyId — wrong company is not returned', async () => {
  await createApplicantNote(noteInput({ body: 'ours' }));
  // Same applicationId, different company — a cross-tenant read must not see it (§6.5).
  await createApplicantNote(noteInput({ companyId: OTHER_COMPANY, body: 'theirs' }));

  const ours = await listApplicantNotesForApplication(COMPANY_ID, APP_ID);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].body, 'ours');

  const theirs = await listApplicantNotesForApplication(OTHER_COMPANY, APP_ID);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].body, 'theirs');
});

test('listApplicantNotesForApplication respects the default limit of 100', async () => {
  const docs = Array.from({ length: 105 }, (_unused, index) => noteInput({
    body: `note ${index}`, createdAt: new Date(2026, 0, 1, 0, index),
  }));
  for (const doc of docs) await createApplicantNote(doc);

  const capped = await listApplicantNotesForApplication(COMPANY_ID, APP_ID);
  assert.equal(capped.length, 100);
  assert.equal(capped[0].body, 'note 104'); // newest survives the cap, oldest is dropped
  const raised = await listApplicantNotesForApplication(COMPANY_ID, APP_ID, { limit: 105 });
  assert.equal(raised.length, 105);
});

test('ensureApplicantNoteIndexes installs idempotently', async () => {
  await ensureApplicantNoteIndexes();
  await ensureApplicantNoteIndexes(); // second run is a no-op, not a throw
  const db = await connectTestDb();
  const indexes = await db.collection('applicant_notes').indexes();
  const names = indexes.map((index) => index.name);
  assert.ok(names.includes('applicant_notes_company_application_createdAt'));
});

test('toPublicApplicantNote stringifies ids and keeps timestamps as Dates', async () => {
  const note = await createApplicantNote(noteInput());
  const shape = toPublicApplicantNote(note);
  assert.equal(shape.id, note._id.toString());
  assert.equal(shape.applicationId, APP_ID.toString());
  assert.equal(shape.authorEmployerUserId, AUTHOR_ID.toString());
  assert.equal(shape.authorEmail, 'owner@acme.com');
  assert.ok(shape.createdAt instanceof Date);
  assert.equal(shape.companyId, undefined); // companyId is never exposed to the client
});
