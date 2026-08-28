// FILE: src/api/admin/queue-monitor-routes.js
// Queue Monitor. Mounted at /api/admin/queues behind requireAdmin (server.js),
// before the generic /api/admin router.
//
// The retry route is the only write in this feature. It reports its refusals as
// `{ retried: false, reason }` with a 200 rather than an error status: "that job
// is no longer failed" is an answer, not a fault, and the UI shows the reason.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  getQueueOverview as defaultGetQueueOverview,
  listFailedJobs as defaultListFailedJobs,
  retryFailedJob as defaultRetryFailedJob,
  isKnownQueue as defaultIsKnownQueue,
} from '../../services/admin/queue-monitor-service.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** "50" → 50. Anything unparseable falls back to the default; capped at 100. */
export function parseLimit(limit) {
  const parsed = parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** Deps are injectable so route tests need neither a database nor live workers. */
export function createQueueMonitorRouter(deps = {}) {
  const {
    getQueueOverview = defaultGetQueueOverview,
    listFailedJobs = defaultListFailedJobs,
    retryFailedJob = defaultRetryFailedJob,
    isKnownQueue = defaultIsKnownQueue,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ data: { queues: await getQueueOverview() } });
  }));

  router.get('/:queueKey/failed', asyncHandler(async (req, res) => {
    const { queueKey } = req.params;
    if (!isKnownQueue(queueKey)) {
      return res.status(400).json({ error: 'Unknown queue', code: 'unknown_queue' });
    }
    const jobs = await listFailedJobs(queueKey, parseLimit(req.query?.limit));
    return res.json({ data: { jobs } });
  }));

  router.post('/:queueKey/failed/:jobId/retry', asyncHandler(async (req, res) => {
    const { queueKey, jobId } = req.params;
    if (!isKnownQueue(queueKey)) {
      return res.status(400).json({ error: 'Unknown queue', code: 'unknown_queue' });
    }
    return res.json({ data: await retryFailedJob(queueKey, jobId) });
  }));

  return router;
}

export default createQueueMonitorRouter;
