import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { archiveApplicant, unarchiveApplicant, bulkArchiveApplicants } from '../../src/services/employer/applicant-archive-service.js';

const COMPANY_ID = new ObjectId();
const OTHER_COMPANY = new ObjectId();
const STAGE_ID = new ObjectId();
const REASON_ID = new ObjectId();
const OTHER_REASON = new ObjectId();
const APP_ID = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset(archived = null) {
  await dropCollections('applications', 'archive_reasons', 'stage_changes');
  await (await col('archive_reasons')).insertMany([
    { _id: REASON_ID, companyId: COMPANY_ID, text: 'Underqualified', type: 'non-hired' },
    { _id: OTHER_REASON, companyId: OTHER_COMPANY, text: 'Underqualified', type: 'non-hired' },
  ]);
  await (await col('applications')).insertOne({
    _id: APP_ID, companyId: COMPANY_ID, stageId: STAGE_ID, contactId: new ObjectId(), jobId: new ObjectId(), archived,
  });
}

test('archive sets application.archived and appends a stage_change', async () => {
  const result = await archiveApplicant(COMPANY_ID, APP_ID, { reasonId: REASON_ID, note: 'too junior' });
  assert.equal(result.application.archived.reasonId, REASON_ID.toString());
  assert.equal(result.application.archived.note, 'too junior');
  assert.ok(result.application.archived.at);
  const change = await (await col('stage_changes')).findOne({});
  assert.equal(change.note, 'Archived: Underqualified');
});

test('already archived → ALREADY_ARCHIVED', async () => {
  await reset({ at: new Date(), reasonId: REASON_ID });
  await assert.rejects(
    () => archiveApplicant(COMPANY_ID, APP_ID, { reasonId: REASON_ID }),
    (err) => { assert.equal(err.status, 409); assert.equal(err.code, 'ALREADY_ARCHIVED'); return true; },
  );
});

test('cross-company reasonId → REASON_NOT_FOUND', async () => {
  await assert.rejects(
    () => archiveApplicant(COMPANY_ID, APP_ID, { reasonId: OTHER_REASON }),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'REASON_NOT_FOUND'); return true; },
  );
});

test('unarchive clears the flag and appends a stage_change', async () => {
  await reset({ at: new Date(), reasonId: REASON_ID });
  const result = await unarchiveApplicant(COMPANY_ID, APP_ID);
  assert.equal(result.application.archived, null);
  const change = await (await col('stage_changes')).findOne({ note: 'Unarchived' });
  assert.ok(change);
});

test('unarchive when never archived → NOT_ARCHIVED', async () => {
  await assert.rejects(
    () => unarchiveApplicant(COMPANY_ID, APP_ID),
    (err) => { assert.equal(err.status, 409); assert.equal(err.code, 'NOT_ARCHIVED'); return true; },
  );
});

// ─── Bulk archive (PP1) ────────────────────────────────────────────

async function insertApp(companyId = COMPANY_ID, archived = null) {
  const id = new ObjectId();
  await (await col('applications')).insertOne({
    _id: id, companyId, stageId: STAGE_ID, contactId: new ObjectId(), jobId: new ObjectId(), archived,
  });
  return id;
}

test('bulk happy path: 3 valid apps → succeeded 3, failed 0, total 3', async () => {
  const ids = [await insertApp(), await insertApp(), await insertApp()];
  const result = await bulkArchiveApplicants(COMPANY_ID, { applicationIds: ids, reasonId: REASON_ID });
  assert.equal(result.total, 3);
  assert.equal(result.successCount, 3);
  assert.equal(result.failureCount, 0);
  assert.equal(result.succeeded.length, 3);
  assert.deepEqual(result.failed, []);
});

test('bulk empty array → HttpError 400 BULK_EMPTY', async () => {
  await assert.rejects(
    () => bulkArchiveApplicants(COMPANY_ID, { applicationIds: [], reasonId: REASON_ID }),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'BULK_EMPTY'); return true; },
  );
});

test('bulk >50 items → HttpError 400 BULK_LIMIT_EXCEEDED', async () => {
  const ids = Array.from({ length: 51 }, () => new ObjectId().toString());
  await assert.rejects(
    () => bulkArchiveApplicants(COMPANY_ID, { applicationIds: ids, reasonId: REASON_ID }),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'BULK_LIMIT_EXCEEDED'); return true; },
  );
});

test('bulk invalid reasonId → HttpError 400 REASON_NOT_FOUND (whole request)', async () => {
  const ids = [await insertApp()];
  await assert.rejects(
    () => bulkArchiveApplicants(COMPANY_ID, { applicationIds: ids, reasonId: new ObjectId() }),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'REASON_NOT_FOUND'); return true; },
  );
});

test('bulk mixed: 2 valid + already-archived + wrong-company → 2 succeeded, 2 coded failures', async () => {
  const v1 = await insertApp();
  const v2 = await insertApp();
  const archived = await insertApp(COMPANY_ID, { at: new Date(), reasonId: REASON_ID });
  const wrongCompany = await insertApp(OTHER_COMPANY);
  const result = await bulkArchiveApplicants(
    COMPANY_ID, { applicationIds: [v1, v2, archived, wrongCompany], reasonId: REASON_ID },
  );
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 2);
  const codeById = Object.fromEntries(result.failed.map((f) => [f.id, f.code]));
  assert.equal(codeById[archived.toString()], 'ALREADY_ARCHIVED');
  assert.equal(codeById[wrongCompany.toString()], 'APPLICATION_NOT_FOUND');
});

test('bulk dedupes duplicate ids: [a, a, b] → total 2', async () => {
  const a = await insertApp();
  const b = await insertApp();
  const result = await bulkArchiveApplicants(
    COMPANY_ID, { applicationIds: [a.toString(), a.toString(), b.toString()], reasonId: REASON_ID },
  );
  assert.equal(result.total, 2);
  assert.equal(result.successCount, 2);
});

test('bulk threads movedByUserId into the stage_change', async () => {
  const userId = new ObjectId();
  const id = await insertApp();
  await bulkArchiveApplicants(COMPANY_ID, { applicationIds: [id], reasonId: REASON_ID }, userId);
  const change = await (await col('stage_changes')).findOne({ applicationId: id });
  assert.equal(change.movedByUserId.toString(), userId.toString());
});

test('bulk processes sequentially in input order (stage_changes monotonic by _id)', async () => {
  const a = await insertApp();
  const b = await insertApp();
  const c = await insertApp();
  await bulkArchiveApplicants(COMPANY_ID, { applicationIds: [a, b, c], reasonId: REASON_ID });
  const changes = await (await col('stage_changes')).find({}).sort({ _id: 1 }).toArray();
  assert.deepEqual(
    changes.map((change) => change.applicationId.toString()),
    [a.toString(), b.toString(), c.toString()],
  );
});
