// FILE: src/models/public/stage-change-model.js
// stage_changes collection — append-only audit of application stage moves
// (SPEC §5.2). movedByUserId is null for system moves (e.g. the initial move
// into the default stage on apply, R6).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const stageChangesCol = () => col('stage_changes');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureStageChangeIndexes() {
  const collection = await stageChangesCol();
  await collection.createIndex({ applicationId: 1, movedAt: -1 }, { name: 'stage_changes_application_movedAt' });
}

/** Record a stage move. fromStageId null = initial placement. */
export async function createStageChange(data) {
  const collection = await stageChangesCol();
  const doc = {
    applicationId: toOid(data.applicationId),
    fromStageId: toOid(data.fromStageId),
    toStageId: toOid(data.toStageId),
    movedByUserId: toOid(data.movedByUserId),
    movedAt: data.movedAt ?? new Date(),
    note: data.note ?? null,
  };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** List an application's stage moves, newest first. */
export async function listStageChangesForApplication(applicationId) {
  const oid = toOid(applicationId);
  if (!oid) return [];
  const collection = await stageChangesCol();
  return collection.find({ applicationId: oid }).sort({ movedAt: -1 }).toArray();
}
