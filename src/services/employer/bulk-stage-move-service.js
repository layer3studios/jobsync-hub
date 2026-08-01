// FILE: src/services/employer/bulk-stage-move-service.js
// Move up to 50 applications to one target stage. NO transaction on purpose —
// standalone MongoDB has none, and per-item independence is the contract: a
// failure on item 3 never rolls back items 1 and 2. Reuses moveApplicantToStage
// (the ONE stage-move path) so tenant guards, the archived freeze and the
// stage_change audit rows match single-move bit-for-bit.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getStageForCompany } from '../../models/employer/stage-model.js';
import { moveApplicantToStage as defaultMoveApplicant } from './applicant-move-service.js';

const BULK_MOVE_MAX_SIZE = 50;

export const BULK_MOVE_ERROR_CODES = {
  BULK_EMPTY: 'BULK_EMPTY',
  BULK_LIMIT_EXCEEDED: 'BULK_LIMIT_EXCEEDED',
  STAGE_NOT_FOUND: 'STAGE_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/** Returns { moved, failed, failures: [{ applicationId, reason }] }. */
export async function bulkMoveStage(companyId, { applicationIds, targetStageId, actorUserId } = {}, deps = {}) {
  const { moveApplicant = defaultMoveApplicant } = deps;

  if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
    throw new HttpError(400, 'applicationIds is required and must be non-empty', BULK_MOVE_ERROR_CODES.BULK_EMPTY);
  }
  if (applicationIds.length > BULK_MOVE_MAX_SIZE) {
    throw new HttpError(400, 'Too many applications in one request', BULK_MOVE_ERROR_CODES.BULK_LIMIT_EXCEEDED);
  }
  // Validate the target once — it's the same for every item, and a cross-tenant
  // stageId must fail the whole request, never be silently applied.
  const stage = await getStageForCompany(companyId, targetStageId);
  if (!stage) throw new HttpError(400, 'Stage not found', BULK_MOVE_ERROR_CODES.STAGE_NOT_FOUND);

  const uniqueIds = [...new Set(applicationIds.map(String))];
  let moved = 0;
  const failures = [];

  for (const id of uniqueIds) {
    try {
      // moveApplicantToStage owns the per-item guards: company ownership
      // (cross-tenant reads as not-found) and the archived freeze.
      await moveApplicant(companyId, id, { stageId: targetStageId }, actorUserId ?? null);
      moved += 1;
    } catch (err) {
      failures.push({
        applicationId: id,
        reason: err instanceof HttpError ? err.code : BULK_MOVE_ERROR_CODES.INTERNAL_ERROR,
      });
    }
  }

  return { moved, failed: failures.length, failures };
}
