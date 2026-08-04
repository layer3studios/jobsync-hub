// FILE: src/services/public/assignment-file-reconciler.js
// Closes the gap in the one dual write this feature cannot make atomic.
//
// An apply commits the submission row (with the FINAL storagePath) and only then
// renames the bytes out of staging. A crash between those two steps leaves a
// committed row pointing at a file that is still in staging. That is deliberate and
// is the safe direction: a row without its file is recoverable — the bytes are
// still on disk under a deterministic name — whereas a moved-or-deleted file with
// no row is gone for good. This module performs the recovery on boot.
//
// It NEVER deletes a submission row. A file missing from both locations is logged
// and counted, because the employer-facing fix for that is a conversation with the
// candidate, not silently dropping their work.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { col } from '../../Db/connection.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STAGING_REL = path.posix.join('data', 'assignment-staging');

const submissionsCol = () => col('assignment_submissions');

const exists = (relativePath) => {
  try {
    return fs.existsSync(path.resolve(BACKEND_ROOT, relativePath));
  } catch {
    return false;
  }
};

/** The staging path a committed file would have come from — same basename, other dir. */
function stagingPathFor(finalStoragePath) {
  return path.posix.join(STAGING_REL, path.basename(String(finalStoragePath || '')));
}

/** Every submission that still expects its files to exist on disk. */
async function liveSubmissions() {
  const collection = await submissionsCol();
  return collection.find({ filesDeletedAt: null }).toArray();
}

/**
 * Promote any committed file still sitting in staging. Returns counts:
 *   promoted — files recovered from the crash window
 *   missing  — files absent from BOTH locations (logged, row left intact)
 */
export async function reconcileAssignmentFiles() {
  let promoted = 0;
  let missing = 0;

  let submissions;
  try {
    submissions = await liveSubmissions();
  } catch (err) {
    // Never block boot on the reconciler.
    console.warn('[assignments] reconcile skipped:', err.message);
    return { promoted: 0, missing: 0 };
  }

  for (const submission of submissions) {
    for (const file of submission.files ?? []) {
      const finalPath = file.storagePath;
      if (!finalPath || exists(finalPath)) continue;

      const stagingPath = stagingPathFor(finalPath);
      if (!exists(stagingPath)) {
        missing += 1;
        console.warn(`[assignments] submission ${submission._id} references a missing file: ${finalPath}`);
        continue;
      }
      try {
        fs.renameSync(
          path.resolve(BACKEND_ROOT, stagingPath),
          path.resolve(BACKEND_ROOT, finalPath),
        );
        promoted += 1;
      } catch (err) {
        missing += 1;
        console.warn(`[assignments] could not promote ${stagingPath}: ${err.message}`);
      }
    }
  }
  return { promoted, missing };
}

/**
 * Every staging path a committed submission could still need. The sweeper takes
 * this so age alone never decides an orphan — see sweepOldStagedFiles.
 */
export async function collectReferencedStagingPaths() {
  const referenced = new Set();
  let submissions;
  try {
    submissions = await liveSubmissions();
  } catch (err) {
    console.warn('[assignments] could not collect referenced staging paths:', err.message);
    // An EMPTY set would tell the sweeper "nothing is referenced" and invite it to
    // delete committed files. Signal the failure instead by returning null.
    return null;
  }
  for (const submission of submissions) {
    for (const file of submission.files ?? []) {
      if (file.storagePath) referenced.add(stagingPathFor(file.storagePath));
    }
  }
  return referenced;
}
