// FILE: src/models/admin/email-event-model.js
// email_events collection — one row per Resend delivery event, fed by the
// webhook receiver. Retention rides `occurredAtExpiry`, a real Date, the same
// technique gemma/usage-stats.js and scrape-run-model use.
//
// Webhooks are retried, so writes are an upsert keyed on
// (resendEmailId, type): the same delivery event arriving twice is one row.

import { col } from '../../Db/connection.js';

const COLLECTION = 'email_events';
const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

const eventsCol = () => col(COLLECTION);

/** Idempotent index setup. Called from server boot. */
export async function ensureEmailEventIndexes() {
  const collection = await eventsCol();
  await collection.createIndex({ occurredAt: -1 }, { name: 'email_events_occurredAt' });
  await collection.createIndex({ to: 1, occurredAt: -1 }, { name: 'email_events_to' });
  // The idempotency key for retried webhooks.
  await collection.createIndex(
    { resendEmailId: 1, type: 1 },
    { unique: true, name: 'email_events_id_type' },
  );
  await collection.createIndex(
    { occurredAtExpiry: 1 },
    { expireAfterSeconds: 0, name: 'email_events_ttl' },
  );
}

/** Anything unparseable becomes `now` — an event is never worth dropping. */
function toDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/**
 * Resend event types arrive as "email.delivered"; the short tail is what the
 * UI filters on. The full original string is kept in `rawType`.
 */
export function shortType(rawType) {
  if (typeof rawType !== 'string' || rawType.length === 0) return 'unknown';
  const tail = rawType.includes('.') ? rawType.split('.').pop() : rawType;
  return tail || 'unknown';
}

/**
 * Upsert one delivery event. Idempotent on (resendEmailId, type) so a webhook
 * retry updates the existing row rather than duplicating it.
 */
export async function recordEmailEvent({ resendEmailId, rawType, to, subject, occurredAt } = {}) {
  const type = shortType(rawType);
  const when = toDate(occurredAt);
  const collection = await eventsCol();
  await collection.updateOne(
    { resendEmailId: resendEmailId ?? null, type },
    {
      $set: {
        to: Array.isArray(to) ? to.join(', ') : (to ?? null),
        subject: subject ?? null,
        occurredAt: when,
        rawType: typeof rawType === 'string' ? rawType : null,
        occurredAtExpiry: new Date(when.getTime() + RETENTION_DAYS * MS_PER_DAY),
      },
      $setOnInsert: { resendEmailId: resendEmailId ?? null, type, createdAt: new Date() },
    },
    { upsert: true },
  );
  return { resendEmailId: resendEmailId ?? null, type };
}

/** Newest first, optionally narrowed by recipient substring and/or type. */
export async function listEmailEvents({ to, type, limit = 100 } = {}) {
  const collection = await eventsCol();
  const filter = {};
  if (type) filter.type = type;
  if (to) filter.to = { $regex: String(to).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return collection.find(filter, { projection: { occurredAtExpiry: 0 } })
    .sort({ occurredAt: -1 })
    .limit(limit)
    .toArray();
}

export default recordEmailEvent;
