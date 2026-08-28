// FILE: src/models/dpdp/audit-log-model.js
// audit_log collection — immutable, append-only (C7). This module deliberately
// exports NO update or delete function; appendAuditLog is the only writer. That
// omission is the enforcement mechanism for immutability.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const auditCol = () => col('audit_log');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureAuditLogIndexes() {
  const collection = await auditCol();
  await collection.createIndex({ actorId: 1, createdAt: -1 }, { name: 'audit_actor' });
  await collection.createIndex({ event: 1, createdAt: -1 }, { name: 'audit_event' });
  await collection.createIndex({ targetId: 1, createdAt: -1 }, { name: 'audit_target' });
}

/** The ONLY exported writer. Insert-only; no updatedAt (records never change). */
export async function appendAuditLog(entry) {
  const collection = await auditCol();
  const doc = {
    event: entry.event,
    actorType: entry.actorType,
    actorId: toOid(entry.actorId),
    targetType: entry.targetType ?? null,
    targetId: toOid(entry.targetId),
    purpose: entry.purpose ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Most-recent audit entries for an actor. */
export async function listAuditForActor(actorId, { limit = 50 } = {}) {
  const oid = toOid(actorId);
  if (!oid) return [];
  const collection = await auditCol();
  return collection.find({ actorId: oid }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Most-recent entries across every actor, optionally narrowed to one event.
 * The admin viewer's read; still no update or delete path (C7).
 */
export async function listRecentAuditEntries({ event, limit = 100 } = {}) {
  const collection = await auditCol();
  const filter = event ? { event } : {};
  return collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
}

/** Most-recent audit entries of a given event type. */
export async function listAuditByEvent(event, { limit = 50 } = {}) {
  const collection = await auditCol();
  return collection.find({ event }).sort({ createdAt: -1 }).limit(limit).toArray();
}
