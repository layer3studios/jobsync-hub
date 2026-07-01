import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureStageChangeIndexes, createStageChange, listStageChangesForApplication,
} from '../../src/models/public/stage-change-model.js';

const APP = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('stage_changes');
  await ensureStageChangeIndexes();
}

test('create + list ordered by movedAt desc', async () => {
  await createStageChange({ applicationId: APP, fromStageId: null, toStageId: new ObjectId(), movedAt: new Date('2026-01-01') });
  await createStageChange({ applicationId: APP, fromStageId: new ObjectId(), toStageId: new ObjectId(), movedAt: new Date('2026-02-01') });
  const list = await listStageChangesForApplication(APP);
  assert.equal(list.length, 2);
  assert.ok(list[0].movedAt > list[1].movedAt);
  assert.equal(list[1].fromStageId, null); // initial placement
});
