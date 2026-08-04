// FILE: src/services/admin/assignment-deletion-service.js
// DPDP erasure for one candidate's take-home submission.
//
// ORDER IS FILES, THEN ROW, AND IT MATTERS. Deleting the bytes first means a crash
// between the two steps leaves a row still pointing at files that are already gone —
// and the next run is a harmless no-op, because deleteSubmissionFile treats a
// missing file as success. The reverse order leaves a TOMBSTONED row (filesDeletedAt
// set, files: []) whose bytes are still on disk with nothing referencing them: an
// erasure we have told the regulator we performed, that we did not perform, and
// that nothing will ever find again. audit-assignments.js finding 8 exists partly
// to catch that class of mistake.
//
// WHAT SURVIVES: assignmentSnapshot. It is the EMPLOYER's record of the task they
// set — their content, frozen at apply time — not the candidate's personal data.
// Erasing it would destroy the employer's own hiring record and make every
// surviving review of that task unreadable. The seeker's own contributions
// (notes, profile links, files) are what go.

import path from 'path';
import { deleteSubmissionFile } from '../public/assignment-storage-service.js';
import {
  getAssignmentSubmissionForApplication, markSubmissionFilesDeleted,
} from '../../models/public/assignment-submission-model.js';
import { col } from '../../Db/connection.js';
import { appendAudit } from '../dpdp/audit-log-service.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';

/**
 * Erase the seeker-supplied parts of one application's assignment submission.
 *
 * Idempotent and total: a missing submission, an already-erased one, and a file
 * that is already off disk are all ordinary outcomes, not errors. An erasure path
 * that throws on "already done" cannot be safely retried, and a DPDP fulfilment run
 * that half-fails must always be safe to re-run.
 *
 * @returns {{ filesDeleted: number, submissionId: string|null, alreadyDeleted: boolean }}
 */
export async function deleteSubmissionFilesForApplication(applicationId, { actorId = null } = {}) {
  const submission = await getAssignmentSubmissionForApplication(applicationId);
  // No take-home on this application — a plain posting, or a legacy row. Not an error.
  if (!submission) return { filesDeleted: 0, submissionId: null, alreadyDeleted: false };

  const submissionId = submission._id.toString();
  if (submission.filesDeletedAt) {
    return { filesDeleted: 0, submissionId, alreadyDeleted: true };
  }

  // ── 1. The bytes, first. Best-effort per file; missing is success. ──────────
  let filesDeleted = 0;
  for (const file of submission.files ?? []) {
    if (!file?.storagePath) continue;
    deleteSubmissionFile(file.storagePath);
    filesDeleted += 1;
  }

  // ── 2. The row, second. Sets filesDeletedAt and empties files[]. ────────────
  await markSubmissionFilesDeleted(submission.companyId, submission._id);

  // ── 3. The other seeker-supplied fields. assignmentSnapshot is NOT touched. ─
  const submissionsCollection = await col('assignment_submissions');
  await submissionsCollection.updateOne(
    { _id: submission._id },
    { $set: { seekerNotesMarkdown: '', profileLinks: { githubUrl: null, linkedinUrl: null } } },
  );

  // audit: DPDP erasure of assignment submission files + seeker-supplied fields.
  // Ids and counts only — an audit row must never restate the data it erased.
  await appendAudit({
    event: AUDIT_EVENTS.DATA_DELETED,
    actorType: 'admin',
    actorId,
    targetType: 'assignment_submission',
    targetId: submission._id,
    metadata: {
      filesDeleted,
      // Filenames are candidate-supplied; only the count is recorded.
      fileExtensions: (submission.files ?? [])
        .map((file) => path.extname(file?.storagePath ?? '').replace('.', ''))
        .filter(Boolean),
      snapshotPreserved: true,
    },
  });

  return { filesDeleted, submissionId, alreadyDeleted: false };
}

/*
 * WHERE THIS MUST BE CALLED, ONCE DPDP FULFILMENT EXISTS.
 *
 * There is no deletion pipeline today. src/services/dpdp/rights-request-service.js
 * only INTAKES a request: it logs the row, stamps a 90-day dueBy, writes an audit
 * entry, and console.warns the grievance officer. Nothing anywhere fulfils an
 * erasure — there is no status transition to 'completed' and no code that removes
 * seeker data.
 *
 * Inventing that pipeline here would be far out of scope for this chunk and would
 * be the wrong shape besides: real fulfilment has to span resumes, applications,
 * contacts, notes and consents, and it needs an operator-facing review step before
 * anything irreversible runs. This function is one leaf of it.
 *
 * When that work happens, call this from the erasure fulfilment handler once per
 * application belonging to the requesting seeker, alongside the resume-file
 * equivalent, and BEFORE the application row itself is anonymised — this needs
 * application.assignmentSubmissionId to still resolve.
 */

export default deleteSubmissionFilesForApplication;
