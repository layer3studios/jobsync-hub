// FILE: src/services/employer/applicant-archive-service.js
// Archive / unarchive an application (D4, R7). Archiving sets
// application.archived = { at, reasonId, note } (SPEC §5.2) — the record is never
// deleted, it's audit history. Both operations append a stage_change so the
// timeline is complete. The archive reason MUST belong to the company (§6.5/C7).

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany } from '../../models/public/application-model.js';
import { createStageChange } from '../../models/public/stage-change-model.js';
import { getArchiveReasonForCompany } from '../../models/employer/archive-reason-model.js';
import { toEmployerApplication } from './applicant-mappers.js';
import { setApplicationFieldsForCompany } from './application-writer.js';

// Cap on one bulk request (R4/D1). Sequential loop; async/paging is future scaling work.
const BULK_ARCHIVE_MAX_SIZE = 50;

// No magic strings for bulk error codes (C2/D4). Whole-request codes surface as
// thrown HttpErrors; per-item codes land in the failed[] entries.
const BULK_ARCHIVE_ERROR_CODES = {
  BULK_EMPTY: 'BULK_EMPTY',                       // 400 whole-request
  BULK_LIMIT_EXCEEDED: 'BULK_LIMIT_EXCEEDED',     // 400 whole-request
  REASON_NOT_FOUND: 'REASON_NOT_FOUND',           // 400 whole-request
  APPLICATION_NOT_FOUND: 'APPLICATION_NOT_FOUND', // per-item
  ALREADY_ARCHIVED: 'ALREADY_ARCHIVED',           // per-item
  INTERNAL_ERROR: 'INTERNAL_ERROR',               // per-item fallback
};

/** Archive an application under a company-owned reason. Refuses if already archived. */
export async function archiveApplicant(companyId, applicationId, { reasonId, note } = {}, movedByUserId = null) {
  const reason = await getArchiveReasonForCompany(companyId, reasonId);
  if (!reason) throw new HttpError(400, 'Archive reason not found', 'REASON_NOT_FOUND');

  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  if (application.archived) throw new HttpError(409, 'Application is already archived', 'ALREADY_ARCHIVED');

  const updated = await setApplicationFieldsForCompany(companyId, application._id, {
    archived: { at: new Date(), reasonId: reason._id, note: note ?? null },
  });
  await createStageChange({
    applicationId: application._id,
    fromStageId: application.stageId,
    toStageId: application.stageId,
    movedByUserId,
    note: `Archived: ${reason.text}`,
  });

  return { application: toEmployerApplication(updated) };
}

/**
 * Archive many applications in one request (D1, R1). Reuses archiveApplicant per item
 * so semantics (stage_change, audit trail, reason validation) match single-archive
 * bit-for-bit. The reason is validated once up front (whole-request failure); per-item
 * failures are collected into failed[] rather than aborting the run (partial success is
 * first-class). Sequential (R4) and deduped (R5). companyId is caller-supplied (C2/C8).
 */
export async function bulkArchiveApplicants(companyId, { applicationIds, reasonId, note } = {}, movedByUserId = null) {
  if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
    throw new HttpError(400, 'applicationIds is required and must be non-empty', BULK_ARCHIVE_ERROR_CODES.BULK_EMPTY);
  }
  if (applicationIds.length > BULK_ARCHIVE_MAX_SIZE) {
    throw new HttpError(400, 'Too many applications in one request', BULK_ARCHIVE_ERROR_CODES.BULK_LIMIT_EXCEEDED);
  }
  // Validate the reason once — it's the same for every item (matches single-archive).
  const reason = await getArchiveReasonForCompany(companyId, reasonId);
  if (!reason) throw new HttpError(400, 'Archive reason not found', BULK_ARCHIVE_ERROR_CODES.REASON_NOT_FOUND);

  // Dedupe by string value, preserving first-seen order for deterministic output (R5).
  const uniqueIds = [...new Set(applicationIds.map(String))];
  const succeeded = [];
  const failed = [];

  for (const id of uniqueIds) {
    try {
      await archiveApplicant(companyId, id, { reasonId, note }, movedByUserId);
      succeeded.push({ id });
    } catch (err) {
      if (err instanceof HttpError) {
        failed.push({ id, code: err.code, message: err.message });
      } else {
        failed.push({ id, code: BULK_ARCHIVE_ERROR_CODES.INTERNAL_ERROR, message: 'Internal error' });
      }
    }
  }

  return {
    succeeded,
    failed,
    total: uniqueIds.length,
    successCount: succeeded.length,
    failureCount: failed.length,
  };
}

/** Clear the archived flag. Refuses if the application was never archived. */
export async function unarchiveApplicant(companyId, applicationId, movedByUserId = null) {
  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  if (!application.archived) throw new HttpError(409, 'Application is not archived', 'NOT_ARCHIVED');

  const updated = await setApplicationFieldsForCompany(companyId, application._id, { archived: null });
  await createStageChange({
    applicationId: application._id,
    fromStageId: application.stageId,
    toStageId: application.stageId,
    movedByUserId,
    note: 'Unarchived',
  });

  return { application: toEmployerApplication(updated) };
}
