// FILE: src/models/dpdp/data-export-request-model.js
// data_export_requests collection — the one-time link behind the candidate-facing
// DPDP right of access. A candidate has no JobMesh account, so the only thing that
// can prove they own an email address is that they can read mail sent to it: the
// token IS the credential, and it is emailed nowhere else.
//
// SINGLE-USE AND SHORT-LIVED. 24 hours, consumed on first successful download. A
// link that lives in an inbox forever is a standing key to someone's personal data,
// and the email it sits in is exactly the thing most likely to be forwarded.
//
// Token storage matches company_invite_model: a 256-bit random string under a unique
// index. Deliberately the same shape rather than a second, divergent scheme.

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const exportRequestsCol = () => col('data_export_requests');

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** URL-safe 256-bit token. */
export function generateExportToken() {
  return crypto.randomBytes(TOKEN_BYTE_LENGTH).toString('base64url');
}

/** Idempotent index setup. Called on boot. */
export async function ensureDataExportRequestIndexes() {
  const collection = await exportRequestsCol();
  await collection.createIndex({ token: 1 }, { unique: true, name: 'data_export_requests_token' });
  // Mongo sweeps consumed and lapsed rows on its own — an expired credential should
  // not need a cron job to stop existing.
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'data_export_requests_ttl' });
}

/** Issue a link for one contact. Returns the doc, token included (emailed, not stored elsewhere). */
export async function createDataExportRequest({ companyId, contactId, email, ipAddress = null }) {
  const now = new Date();
  const doc = {
    companyId: toOid(companyId),
    contactId: toOid(contactId),
    email: String(email).trim().toLowerCase(),
    token: generateExportToken(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    usedAt: null,
    ipAddress,
    createdAt: now,
  };
  const collection = await exportRequestsCol();
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * Consume a token: find it, check it is unused and unexpired, and mark it used — all
 * in ONE atomic findOneAndUpdate. Two clicks on the same link in the same second
 * cannot both succeed, because the filter that finds an unused row is the same
 * operation that marks it used.
 *
 * Returns the consumed doc, or null for unknown / expired / already-used. The three
 * are indistinguishable on purpose: a caller learns "this link does not work", never
 * which of those it is.
 */
export async function consumeDataExportRequest(token, now = new Date()) {
  if (typeof token !== 'string' || !token) return null;
  const collection = await exportRequestsCol();
  return collection.findOneAndUpdate(
    { token, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' },
  );
}
