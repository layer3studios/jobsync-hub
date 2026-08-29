// FILE: src/services/admin/posting-indexing-hook.js
// The one thing employer lifecycle code calls. Everything here is fire-and-forget
// and swallows its own errors: telling Google about a URL must never be able to
// fail, delay, or alter the posting operation that triggered it.
//
// NATIVE ONLY, enforced here rather than at the call sites. Google's Indexing API
// is for pages you own and is capped at 200 URLs/day; a scraped job's URL belongs
// to another company's ATS and must never be submitted.
//
// URL SHAPE: the public apply page is /apply/{companySlug}/{jobSlug}, built
// absolute from FRONTEND_URL. Both slugs are required — a posting whose company
// cannot be resolved is skipped rather than submitted under a guessed path.

import { FRONTEND_URL } from '../../env.js';
import { col } from '../../Db/connection.js';
import { enqueueIndexingJob, INDEXING_ACTIONS } from '../../models/admin/indexing-job-model.js';

const NATIVE = 'native';

/** True only for a native employer posting. Scraped jobs carry `sourceSite`. */
export function isNativePosting(posting) {
  return Boolean(posting) && posting.source === NATIVE && !posting.sourceSite;
}

/** `${FRONTEND_URL}/apply/{companySlug}/{jobSlug}` — the public apply page. */
export function buildPostingUrl(companySlug, jobSlug) {
  if (!companySlug || !jobSlug) return null;
  const origin = String(FRONTEND_URL).replace(/\/$/, '');
  return `${origin}/apply/${encodeURIComponent(companySlug)}/${encodeURIComponent(jobSlug)}`;
}

/** The posting's company slug, read once per call. Null when unresolvable. */
async function companySlugFor(posting) {
  if (!posting?.companyId) return null;
  const companies = await col('companies');
  const company = await companies.findOne(
    { _id: posting.companyId },
    { projection: { slug: 1 } },
  );
  return company?.slug ?? null;
}

/**
 * Queue a submission for one posting. `change` is 'updated' or 'deleted'.
 * Resolves to a result object for tests; callers ignore it.
 * NEVER throws and never rejects.
 */
export async function enqueuePostingIndexing(posting, change, deps = {}) {
  const { enqueue = enqueueIndexingJob, getCompanySlug = companySlugFor } = deps;
  try {
    if (!isNativePosting(posting)) return { enqueued: false, reason: 'not_native' };

    const companySlug = await getCompanySlug(posting);
    const url = buildPostingUrl(companySlug, posting.slug);
    if (!url) return { enqueued: false, reason: 'no_url' };

    const action = change === 'deleted' ? INDEXING_ACTIONS.DELETED : INDEXING_ACTIONS.UPDATED;
    return await enqueue({ postingId: posting._id, url, action });
  } catch (err) {
    console.warn(`[indexing] enqueue failed: ${err.message}`);
    return { enqueued: false, reason: 'error' };
  }
}

/**
 * The call shape lifecycle handlers use: fully detached, so nothing awaits it and
 * no rejection can escape into the request. Mirrors fireExtraction in
 * employer-postings-routes.js.
 */
export function fireIndexing(posting, change) {
  Promise.resolve()
    .then(() => enqueuePostingIndexing(posting, change))
    .catch((err) => console.warn(`[indexing] enqueue failed: ${err.message}`));
}

export default fireIndexing;
