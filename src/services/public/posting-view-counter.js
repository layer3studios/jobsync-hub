// FILE: src/services/public/posting-view-counter.js
// Counts genuine candidate views of a public job page. Deliberately cheap and
// deliberately lossy: one atomic $inc, fire-and-forget, never awaited into the
// response path. A dropped view is invisible; a failed page is not.
//
// TWO KINDS OF VISITOR NEVER COUNT:
//  1. The employer. Anyone carrying the employer auth cookie is checking their own
//     posting, and a number that climbs while you refresh your own page is noise.
//     Presence of the cookie is enough — this is a metric, not an authorization
//     decision, so verifying the token would buy accuracy nobody can perceive.
//  2. Bots. A crawler hitting the page is not a candidate reading it.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';
import { EMPLOYER_COOKIE_NAME } from '../../env.js';

const BOT_PATTERN = /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|preview|headless|monitor|curl|wget|python-requests|axios|node-fetch|scrapy|lighthouse/i;

/** True when this request should not move the counter. */
export function isNonCountableView(req) {
  if (req.cookies?.[EMPLOYER_COOKIE_NAME]) return true;
  const userAgent = req.get?.('user-agent') || '';
  if (!userAgent.trim()) return true; // no UA at all is a script, not a browser
  return BOT_PATTERN.test(userAgent);
}

/**
 * Increment a posting's view count. Never throws and never rejects — callers
 * invoke it without awaiting, so a rejection here would be an unhandled one.
 */
export function recordPostingView(postingId) {
  const oid = postingId instanceof ObjectId ? postingId : null;
  if (!oid) return;
  col('jobs')
    .then((collection) => collection.updateOne({ _id: oid }, { $inc: { viewCount: 1 } }))
    .catch((err) => console.warn('[views] increment failed:', err?.message || err));
}

/** Count the view unless the visitor is an employer or a bot. */
export function countPublicPostingView(req, posting) {
  if (!posting?._id || isNonCountableView(req)) return false;
  recordPostingView(posting._id);
  return true;
}

export default countPublicPostingView;
