// FILE: src/tasks/process-erasure-requests.js
// Fulfil open DPDP erasure requests. Run on a schedule, or by hand when the
// grievance officer wants the queue drained now.
//
// IDEMPOTENT BY CONSTRUCTION, at both levels: the query only ever selects open
// requests, and fulfillErasureRequest re-checks status before touching anything. So
// running this twice in a row, or interleaved with an admin clicking "Process", can
// erase the same person twice without erasing anything twice.
//
// ONE FAILURE DOES NOT STOP THE QUEUE. Each request is fulfilled inside its own
// try/catch: a request that throws is logged and left open for the next run, and the
// rest of the queue still gets processed. An erasure task that gives up on the first
// bad row is how a 90-day SLA quietly goes unmet.

import { closeDb } from '../Db/connection.js';
import { listOpenRightsRequests } from '../models/dpdp/rights-request-model.js';
import { RIGHTS_REQUEST_TYPES } from '../models/dpdp/dpdp-constants.js';
import { fulfillErasureRequest } from '../services/dpdp/erasure-service.js';

/**
 * Process open erasure requests.
 *
 * By default this drains the WHOLE open queue rather than only requests past their
 * 90-day dueBy. The SLA is a deadline, not a waiting period — holding someone's data
 * for 89 more days because we are allowed to is not a thing this task should do.
 * Pass { onlyOverdue: true } to restrict it to the ones actually at the wall.
 */
export async function processErasureRequests({ onlyOverdue = false, now = new Date() } = {}) {
  const requests = await listOpenRightsRequests({
    types: [RIGHTS_REQUEST_TYPES.ERASURE],
    dueBefore: onlyOverdue ? now : undefined,
  });

  if (requests.length === 0) {
    console.log('[erasure] No open erasure requests');
    return { processed: 0, failed: 0, summaries: [] };
  }

  const summaries = [];
  let failed = 0;
  for (const request of requests) {
    try {
      const summary = await fulfillErasureRequest(request._id, { actor: { type: 'system', id: null } });
      summaries.push(summary);
      console.log(
        `[erasure] Fulfilled ${summary.rightsRequestId}: `
        + `${summary.companiesProcessed ?? 0} companies, ${summary.applicationsProcessed ?? 0} applications, `
        + `${summary.filesDeleted ?? 0} files, ${summary.notesRedacted ?? 0} notes`,
      );
    } catch (error) {
      failed += 1;
      console.error(`[erasure] Request ${request._id.toString()} failed: ${error.message}`);
    }
  }

  console.log(`[erasure] Processed ${summaries.length} request(s), ${failed} failed`);
  return { processed: summaries.length, failed, summaries };
}

/**
 * Only when executed directly, never on import — so a test or a scheduler can pull
 * processErasureRequests in without the process exiting underneath it.
 */
const isDirectRun = process.argv[1] && process.argv[1].endsWith('process-erasure-requests.js');
if (isDirectRun) {
  processErasureRequests({ onlyOverdue: process.argv.includes('--overdue-only') })
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[erasure] failed: ${err.message}`);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
