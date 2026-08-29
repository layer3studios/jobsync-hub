// FILE: tests/api/admin-email-alerts.test.js
// The Resend webhook (signature verification against a REAL HMAC), the admin
// email log, and the AI budget alert's threshold + cooldown logic.
import '../_helpers/test-db.js'; // MUST be first: sets env before env.js loads
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireAdmin } from '../../src/middleware/require-admin-middleware.js';
import { createResendWebhookRouter, signPayload } from '../../src/api/public/resend-webhook-route.js';
import { createEmailLogRouter } from '../../src/api/admin/email-log-routes.js';
import { ensureEmailEventIndexes } from '../../src/models/admin/email-event-model.js';
import { checkAndAlert, summariseToday, breachesFor } from '../../src/services/admin/ai-alert-service.js';

const SECRET = `whsec_${Buffer.from('a-test-signing-key-32-bytes-long').toString('base64')}`;

const EVENT = {
  type: 'email.delivered',
  created_at: '2026-08-29T10:00:00.000Z',
  data: { email_id: 're_abc123', to: ['someone@example.com'], subject: 'Your interview is confirmed' },
};

/** Mounts express.raw exactly as server.js does, so the bytes reach the route. */
function buildWebhookApp({ secret = SECRET } = {}) {
  const app = express();
  app.use('/api/public/webhooks/resend', express.raw({ type: '*/*', limit: '1mb' }));
  app.use('/api/public/webhooks/resend', createResendWebhookRouter({ webhookSecret: secret }));
  app.use(errorHandler);
  return app;
}

/** Sign a body the way Svix does, using the route's own signer. */
function signedHeaders(body, { id = 'msg_1', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signPayload(SECRET, id, String(timestamp), body)}`,
  };
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/email-log', requireAdmin, createEmailLogRouter({ webhookSecret: SECRET }));
  app.use(errorHandler);
  return app;
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'email-log-admin@jobmesh.in';
  await admins.updateOne(
    { email },
    { $set: { email, name: 'Admin', isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  const admin = await admins.findOne({ email });
  cachedCookie = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET)}`;
  return cachedCookie;
}

beforeEach(async () => {
  await dropCollections('email_events');
  await ensureEmailEventIndexes();
});

after(async () => {
  await dropCollections('email_events');
  await (await col('admin_users')).deleteOne({ email: 'email-log-admin@jobmesh.in' });
  await closeTestDb();
});

// ─── Webhook ────────────────────────────────────────────────────────

test('a validly signed event is stored', async () => {
  const body = JSON.stringify(EVENT);
  const res = await request(buildWebhookApp())
    .post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body) })
    .send(body);

  assert.equal(res.status, 200);
  const stored = await (await col('email_events')).findOne({ resendEmailId: 're_abc123' });
  assert.equal(stored.type, 'delivered');            // short tail of email.delivered
  assert.equal(stored.rawType, 'email.delivered');
  assert.equal(stored.to, 'someone@example.com');    // array joined for storage
  assert.equal(stored.subject, 'Your interview is confirmed');
  assert.ok(stored.occurredAtExpiry instanceof Date);
});

test('a bad signature is rejected with 401 and stores nothing', async () => {
  const body = JSON.stringify(EVENT);
  const headers = signedHeaders(body);
  headers['svix-signature'] = 'v1,ZmFrZXNpZ25hdHVyZQ==';

  const res = await request(buildWebhookApp())
    .post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...headers })
    .send(body);

  assert.equal(res.status, 401);
  assert.equal(await (await col('email_events')).countDocuments({}), 0);
});

test('a tampered body fails verification even with the original signature', async () => {
  const body = JSON.stringify(EVENT);
  const headers = signedHeaders(body);
  const tampered = JSON.stringify({ ...EVENT, data: { ...EVENT.data, to: ['attacker@evil.com'] } });

  const res = await request(buildWebhookApp())
    .post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...headers })
    .send(tampered);

  assert.equal(res.status, 401);
  assert.equal(await (await col('email_events')).countDocuments({}), 0);
});

test('missing svix headers are rejected', async () => {
  const res = await request(buildWebhookApp())
    .post('/api/public/webhooks/resend')
    .set('content-type', 'application/json')
    .send(JSON.stringify(EVENT));
  assert.equal(res.status, 401);
});

test('an old timestamp is rejected even when correctly signed (replay)', async () => {
  const body = JSON.stringify(EVENT);
  const stale = Math.floor(Date.now() / 1000) - 3600;
  const res = await request(buildWebhookApp())
    .post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body, { timestamp: stale }) })
    .send(body);
  assert.equal(res.status, 401);
});

test('an unset secret refuses every event with 503, never accepting it', async () => {
  const body = JSON.stringify(EVENT);
  const res = await request(buildWebhookApp({ secret: '' }))
    .post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body) })
    .send(body);

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'WEBHOOK_NOT_CONFIGURED');
  assert.equal(await (await col('email_events')).countDocuments({}), 0);
});

test('a retried webhook upserts rather than duplicating', async () => {
  const app = buildWebhookApp();
  const body = JSON.stringify(EVENT);
  await request(app).post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body) }).send(body);
  await request(app).post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body, { id: 'msg_2' }) }).send(body);

  assert.equal(await (await col('email_events')).countDocuments({ resendEmailId: 're_abc123' }), 1);
});

test('malformed JSON past a valid signature still returns 200 (Resend retries on non-2xx)', async () => {
  const body = 'not json at all';
  const res = await request(buildWebhookApp())
    .post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body) })
    .send(body);
  assert.equal(res.status, 200);
});

// ─── Admin email log ────────────────────────────────────────────────

test('GET /email-log requires an admin cookie', async () => {
  assert.equal((await request(buildAdminApp()).get('/api/admin/email-log')).status, 401);
});

test('GET /email-log returns events newest first with the configured flag', async () => {
  const body = JSON.stringify(EVENT);
  await request(buildWebhookApp()).post('/api/public/webhooks/resend')
    .set({ 'content-type': 'application/json', ...signedHeaders(body) }).send(body);

  const res = await request(buildAdminApp()).get('/api/admin/email-log').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.configured, true);
  assert.equal(res.body.data.events[0].to, 'someone@example.com');
  assert.equal(res.body.data.events[0].type, 'delivered');
});

// ─── AI budget alerts ───────────────────────────────────────────────

const SETTINGS = {
  alertsEnabled: true,
  dailyTokenThreshold: 1_000_000,
  errorRateThresholdPct: 20,
  alertEmails: ['ops@jobmesh.in'],
  lastAlertSentAt: null,
};

/** listUsageStats rows for today, in usage-stats' own shape. */
const statsFor = (today, { tokens, requests, errors }) => [{
  date: today, tier: 'employer', model: 'gemini-3.6-flash', apiKeyIndex: 0,
  requests, tokensEstimated: tokens, cacheHits: 0, errors: { other: errors },
}];

function alertDeps(overrides = {}) {
  const sends = [];
  const marks = [];
  return {
    sends,
    marks,
    deps: {
      getSettings: async () => ({ ...SETTINGS, ...overrides.settings }),
      listStats: async () => overrides.stats ?? [],
      sendEmail: async (email) => { sends.push(email); return { sent: true }; },
      markSent: async (when) => { marks.push(when); },
      now: overrides.now ?? new Date(),
      ...overrides.deps,
    },
  };
}

test('below both thresholds sends nothing', async () => {
  const now = new Date();
  const { sends, deps } = alertDeps({
    stats: statsFor(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now), { tokens: 10_000, requests: 100, errors: 1 }),
    now,
  });
  const result = await checkAndAlert(deps);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'below_thresholds');
  assert.equal(sends.length, 0);
});

test('crossing the token threshold sends exactly one alert and stamps the clock', async () => {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const { sends, marks, deps } = alertDeps({
    stats: statsFor(today, { tokens: 2_000_000, requests: 100, errors: 0 }),
    now,
  });

  const result = await checkAndAlert(deps);
  assert.equal(result.sent, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'ops@jobmesh.in');
  assert.match(sends[0].subject, /AI usage alert/);
  assert.match(sends[0].text, /2,000,000/);
  assert.equal(marks.length, 1);
});

test('a second check inside the 12h cooldown sends nothing', async () => {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const { sends, deps } = alertDeps({
    stats: statsFor(today, { tokens: 5_000_000, requests: 100, errors: 0 }),
    settings: { lastAlertSentAt: new Date(now.getTime() - 60 * 60 * 1000) }, // 1h ago
    now,
  });

  const result = await checkAndAlert(deps);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'cooldown');
  assert.equal(sends.length, 0);
});

test('alerts disabled, or no recipients, never sends', async () => {
  const disabled = alertDeps({ settings: { alertsEnabled: false } });
  assert.equal((await checkAndAlert(disabled.deps)).reason, 'alerts_disabled');
  assert.equal(disabled.sends.length, 0);

  const noRecipients = alertDeps({ settings: { alertEmails: [] } });
  assert.equal((await checkAndAlert(noRecipients.deps)).reason, 'no_recipients');
  assert.equal(noRecipients.sends.length, 0);
});

test('checkAndAlert never throws when a dependency fails', async () => {
  const result = await checkAndAlert({
    getSettings: async () => { throw new Error('mongo is down'); },
  });
  assert.deepEqual(result, { sent: false, reason: 'error' });
});

test('the error-rate threshold ignores tiny samples', () => {
  const settings = { dailyTokenThreshold: 1e9, errorRateThresholdPct: 20 };
  // 2 of 5 calls failed = 40%, but 5 calls is noise, not a signal.
  assert.deepEqual(breachesFor(summariseToday([{ requests: 5, tokensEstimated: 1, errors: { other: 2 } }]), settings), []);
  // 25 of 100 crosses it.
  const real = breachesFor(summariseToday([{ requests: 100, tokensEstimated: 1, errors: { other: 25 } }]), settings);
  assert.equal(real.length, 1);
  assert.match(real[0], /Error rate 25%/);
});
