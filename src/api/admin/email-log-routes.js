// FILE: src/api/admin/email-log-routes.js
// GET /api/admin/email-log?to=&type=&limit= — Resend delivery events.
// Mounted behind requireAdmin (server.js), before the generic /api/admin router.
// Read-only.
//
// `configured` tells the UI whether RESEND_WEBHOOK_SECRET is set: an empty log
// means "nothing sent" or "the webhook was never wired up", and those are very
// different problems.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { listEmailEvents as defaultListEmailEvents } from '../../models/admin/email-event-model.js';
import { RESEND_WEBHOOK_SECRET } from '../../env.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** "50" → 50. Anything unparseable falls back to the default; capped at 500. */
export function parseLimit(limit) {
  const parsed = parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function toPublicEvent(event) {
  return {
    id: event._id.toString(),
    resendEmailId: event.resendEmailId ?? null,
    type: event.type,
    rawType: event.rawType ?? null,
    to: event.to ?? null,
    subject: event.subject ?? null,
    occurredAt: event.occurredAt ?? null,
  };
}

/** Deps are injectable so route tests need no database. */
export function createEmailLogRouter(deps = {}) {
  const {
    listEmailEvents = defaultListEmailEvents,
    webhookSecret = RESEND_WEBHOOK_SECRET,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const events = await listEmailEvents({
      to: req.query?.to ? String(req.query.to) : undefined,
      type: req.query?.type ? String(req.query.type) : undefined,
      limit: parseLimit(req.query?.limit),
    });
    res.json({
      data: { events: events.map(toPublicEvent), configured: Boolean(webhookSecret) },
    });
  }));

  return router;
}

export default createEmailLogRouter;
