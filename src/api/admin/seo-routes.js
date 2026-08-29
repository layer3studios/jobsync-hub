// FILE: src/api/admin/seo-routes.js
// SEO & indexing panel. Mounted at /api/admin/seo behind requireAdmin (server.js),
// before the generic /api/admin router.
//
// The two POSTs only ever ENQUEUE — they never call Google inline. A request that
// waited on an external API would tie an admin click to Google's latency and to
// the 200/day quota; the worker owns both.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  getSchemaHealth as defaultGetSchemaHealth,
  getIndexingStats as defaultGetIndexingStats,
  getStaleUrls as defaultGetStaleUrls,
  findLiveNativePosting as defaultFindPosting,
} from '../../services/admin/seo-health-service.js';
import { requeueIndexingJob as defaultRequeue } from '../../models/admin/indexing-job-model.js';
import { enqueuePostingIndexing as defaultEnqueuePosting } from '../../services/admin/posting-indexing-hook.js';
import { buildIndexingClient as defaultBuildClient } from '../../services/admin/google-indexing-client.js';

/** Deps are injectable so route tests never touch Google or a database. */
export function createSeoRouter(deps = {}) {
  const {
    getSchemaHealth = defaultGetSchemaHealth,
    getIndexingStats = defaultGetIndexingStats,
    getStaleUrls = defaultGetStaleUrls,
    findLiveNativePosting = defaultFindPosting,
    requeueIndexingJob = defaultRequeue,
    enqueuePostingIndexing = defaultEnqueuePosting,
    buildIndexingClient = defaultBuildClient,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const [schema, indexing, staleUrls] = await Promise.all([
      getSchemaHealth(), getIndexingStats(), getStaleUrls(),
    ]);
    res.json({
      data: {
        // The queue still accepts jobs while unconfigured; they simply wait for
        // credentials. The banner explains that rather than hiding the page.
        configured: Boolean(buildIndexingClient()),
        schema,
        indexing,
        staleUrls,
      },
    });
  }));

  router.post('/retry/:jobId', asyncHandler(async (req, res) => {
    const result = await requeueIndexingJob(req.params.jobId);
    if (!result.ok) {
      throw new HttpError(result.reason === 'invalid_job_id' ? 400 : 404, 'Could not retry that job', result.reason);
    }
    return res.json({ data: result });
  }));

  /**
   * Manually queue one posting. `?action=deleted` submits a removal — that is what
   * the stale-URL list's button uses; the default is an update, for backfilling
   * postings that predate this feature.
   */
  router.post('/submit/:postingId', asyncHandler(async (req, res) => {
    const posting = await findLiveNativePosting(req.params.postingId);
    if (!posting) throw new HttpError(404, 'Native posting not found', 'POSTING_NOT_FOUND');

    const change = req.query?.action === 'deleted' ? 'deleted' : 'updated';
    // A live posting must not be submitted as removed, and vice versa: telling
    // Google to drop a URL that still serves a job would be self-inflicted.
    if (change === 'updated' && posting.status !== 'active') {
      throw new HttpError(400, 'Only a live posting can be submitted for indexing', 'POSTING_NOT_LIVE');
    }
    if (change === 'deleted' && posting.status === 'active') {
      throw new HttpError(400, 'That posting is still live — close it before submitting a removal', 'POSTING_STILL_LIVE');
    }

    const result = await enqueuePostingIndexing(posting, change);
    if (!result?.enqueued) {
      throw new HttpError(400, 'Could not queue that posting', result?.reason ?? 'ENQUEUE_FAILED');
    }
    return res.json({ data: { ...result, action: change } });
  }));

  return router;
}

export default createSeoRouter;
