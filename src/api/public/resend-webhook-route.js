// FILE: src/api/public/resend-webhook-route.js
// POST /api/public/webhooks/resend — Resend delivery events, signed by Svix.
//
// SIGNATURE (Svix spec): the signed payload is `${svix-id}.${svix-timestamp}.${body}`
// where `body` is the EXACT raw bytes. The secret arrives as "whsec_<base64>";
// the base64 half is the HMAC-SHA256 key. The svix-signature header carries a
// space-separated list of `v1,<base64sig>` — a list because Svix rotates keys,
// so any one match is a pass. Compared with timingSafeEqual.
//
// This route is mounted with express.raw (server.js) because the global
// express.json would have already consumed the body — and a re-serialised JSON
// object is not byte-identical to what was signed.
//
// Resend retries on any non-2xx, so processing failures log and still return
// 200. Only an auth failure is allowed to be non-2xx.

import crypto from 'node:crypto';
import { Router } from 'express';
import { RESEND_WEBHOOK_SECRET } from '../../env.js';
import { recordEmailEvent } from '../../models/admin/email-event-model.js';

/** Tolerance for svix-timestamp skew — an old signature must not be replayable. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

let missingSecretLogged = false;

/** "whsec_abc" → the raw key bytes. A bare secret is accepted too. */
export function secretToKey(secret) {
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(base64, 'base64');
}

/** The Svix signed payload: id.timestamp.body */
export function signedContent(svixId, svixTimestamp, rawBody) {
  return `${svixId}.${svixTimestamp}.${rawBody}`;
}

/** Base64 HMAC-SHA256 of the signed content. Exported for the test's signer. */
export function signPayload(secret, svixId, svixTimestamp, rawBody) {
  return crypto
    .createHmac('sha256', secretToKey(secret))
    .update(signedContent(svixId, svixTimestamp, rawBody))
    .digest('base64');
}

function timingSafeMatch(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch; that is itself a non-match.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * True when any `v1,<sig>` entry in the header matches. Header may carry
 * several signatures during a secret rotation.
 */
export function verifySignature({ secret, svixId, svixTimestamp, svixSignature, rawBody, now = Date.now() }) {
  if (!secret || !svixId || !svixTimestamp || !svixSignature) return false;

  const timestamp = Number(svixTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const expected = signPayload(secret, svixId, svixTimestamp, rawBody);
  return String(svixSignature)
    .split(' ')
    .some((part) => {
      const [version, signature] = part.split(',');
      return version === 'v1' && signature && timingSafeMatch(signature, expected);
    });
}

/** Deps are injectable so the route can be tested without env or a database. */
export function createResendWebhookRouter(deps = {}) {
  const {
    webhookSecret = RESEND_WEBHOOK_SECRET,
    recordEvent = recordEmailEvent,
  } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    if (!webhookSecret) {
      if (!missingSecretLogged) {
        console.warn('[resend-webhook] RESEND_WEBHOOK_SECRET is unset — refusing every event');
        missingSecretLogged = true;
      }
      return res.status(503).json({ error: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
    }

    // express.raw leaves a Buffer; anything else means the mount order is wrong.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const ok = verifySignature({
      secret: webhookSecret,
      svixId: req.get('svix-id'),
      svixTimestamp: req.get('svix-timestamp'),
      svixSignature: req.get('svix-signature'),
      rawBody,
    });
    if (!ok) {
      return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
    }

    // Past this point the event is authentic. Resend retries on non-2xx, so a
    // processing failure is logged and acknowledged rather than retried forever.
    try {
      const event = JSON.parse(rawBody);
      const data = event?.data ?? {};
      await recordEvent({
        resendEmailId: data.email_id ?? data.id ?? null,
        rawType: event?.type ?? null,
        to: data.to ?? null,
        subject: data.subject ?? null,
        occurredAt: event?.created_at ?? data.created_at ?? null,
      });
    } catch (err) {
      console.warn(`[resend-webhook] could not record event: ${err.message}`);
    }
    return res.status(200).json({ received: true });
  });

  return router;
}

export default createResendWebhookRouter;
