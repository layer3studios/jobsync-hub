// FILE: tests/services/bulk-stage-move-service.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { createCompany } from '../../src/models/employer/company-model.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';
import { bulkMoveStage } from '../../src/services/employer/bulk-stage-move-service.js';

async function seedCompany(tag) {
  const company = await createCompany({ name: `Acme ${tag}` }, new ObjectId());
  const stages = await seedDefaultStagesForCompany(company._id);
  return { companyId: company._id, stageByText: new Map(stages.map((s) => [s.text, s._id])) };
}

async function seedApplication(companyId, stageId, { archived = null } = {}) {
  const now = new Date();
  const { insertedId } = await (await col('applications')).insertOne({
    companyId, jobId: new ObjectId(), contactId: new ObjectId(), stageId, archived,
    appliedAt: now, lastStageMovedAt: now, createdAt: now, updatedAt: now,
  });
  return insertedId;
}

beforeEach(async () => {
  await dropCollections('companies', 'stages', 'applications', 'stage_changes');
});
after(async () => { await closeTestDb(); });

test('moves 3 applications successfully with correct counts', async () => {
  const { companyId, stageByText } = await seedCompany('a');
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(await seedApplication(companyId, stageByText.get('Applied')));

  const result = await bulkMoveStage(companyId, {
    applicationIds: ids.map(String), targetStageId: stageByText.get('Shortlisted').toString(),
  });
  assert.deepEqual(result, { moved: 3, failed: 0, failures: [] });
  const moved = await (await col('applications'))
    .countDocuments({ companyId, stageId: stageByText.get('Shortlisted') });
  assert.equal(moved, 3);
});

test('an archived application is skipped with a failure reason', async () => {
  const { companyId, stageByText } = await seedCompany('b');
  const okId = await seedApplication(companyId, stageByText.get('Applied'));
  const archivedId = await seedApplication(companyId, stageByText.get('Applied'), {
    archived: { at: new Date(), reasonId: new ObjectId(), note: null },
  });

  const result = await bulkMoveStage(companyId, {
    applicationIds: [okId.toString(), archivedId.toString()],
    targetStageId: stageByText.get('Shortlisted').toString(),
  });
  assert.equal(result.moved, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [{ applicationId: archivedId.toString(), reason: 'CANNOT_MOVE_ARCHIVED' }]);
});

test("another company's application is skipped, not moved", async () => {
  const a = await seedCompany('c');
  const b = await seedCompany('d');
  const foreignId = await seedApplication(b.companyId, b.stageByText.get('Applied'));

  const result = await bulkMoveStage(a.companyId, {
    applicationIds: [foreignId.toString()], targetStageId: a.stageByText.get('Shortlisted').toString(),
  });
  assert.equal(result.moved, 0);
  assert.equal(result.failures[0].reason, 'APPLICATION_NOT_FOUND');
  const untouched = await (await col('applications')).findOne({ _id: foreignId });
  assert.equal(untouched.stageId.toString(), b.stageByText.get('Applied').toString());
});

test('more than 50 ids is rejected whole-request', async () => {
  const { companyId, stageByText } = await seedCompany('e');
  const ids = Array.from({ length: 51 }, () => new ObjectId().toString());
  await assert.rejects(
    bulkMoveStage(companyId, { applicationIds: ids, targetStageId: stageByText.get('Applied').toString() }),
    (err) => err.code === 'BULK_LIMIT_EXCEEDED',
  );
});

test('a cross-tenant target stage fails the whole request', async () => {
  const a = await seedCompany('f');
  const b = await seedCompany('g');
  const appId = await seedApplication(a.companyId, a.stageByText.get('Applied'));
  await assert.rejects(
    bulkMoveStage(a.companyId, {
      applicationIds: [appId.toString()], targetStageId: b.stageByText.get('Shortlisted').toString(),
    }),
    (err) => err.code === 'STAGE_NOT_FOUND',
  );
});
