// FILE: src/services/employer/applicant-mappers.js
// Client-safe projections for the employer applicant views. Kept separate from the
// public application-model's toPublicApplication (which is intentionally minimal):
// the employer needs the archived shape (SPEC §5.2), lastStageMovedAt, and the
// full stage-change history that the seeker/apply side never exposes.

export function toEmployerApplication(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    jobId: doc.jobId?.toString() ?? null,
    contactId: doc.contactId?.toString() ?? null,
    stageId: doc.stageId?.toString() ?? null,
    source: doc.source ?? null,
    coverNote: doc.coverNote ?? null,
    yearsExperience: doc.yearsExperience ?? null,
    tags: doc.tags ?? [],
    appliedAt: doc.appliedAt ?? null,
    lastStageMovedAt: doc.lastStageMovedAt ?? null,
    assignmentSubmissionId: doc.assignmentSubmissionId?.toString() ?? null,
    archived: doc.archived
      ? {
          at: doc.archived.at ?? null,
          reasonId: doc.archived.reasonId?.toString() ?? null,
          note: doc.archived.note ?? null,
        }
      : null,
  };
}

export function toEmployerStageChange(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    fromStageId: doc.fromStageId?.toString() ?? null,
    toStageId: doc.toStageId?.toString() ?? null,
    movedByUserId: doc.movedByUserId?.toString() ?? null,
    note: doc.note ?? null,
    movedAt: doc.movedAt ?? null,
  };
}

export function toResumeMeta(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    originalFilename: doc.originalFilename ?? null,
    mimeType: doc.mimeType ?? null,
    sizeBytes: doc.sizeBytes ?? null,
    uploadedAt: doc.uploadedAt ?? null,
  };
}
