// FILE: src/services/dpdp/anonymize-candidate-service.js
// The actual erasure work for ONE candidate at ONE company.
//
// ANONYMIZE, DO NOT DELETE. Rows survive; the person inside them does not. A deleted
// application would silently rewrite last quarter's funnel numbers, so the record of
// "someone applied to this posting, reached this stage, on this date" is kept while
// every field that could identify who they were is overwritten.
//
// WHAT SURVIVES, AND WHY:
//   resume_scores   numbers and skill names — no PII, and the aggregate depends on it
//   stage_changes   the pipeline audit trail — no PII
//   applications    kept, with coverNote/IP/user-agent/referer nulled
//   notes           kept as rows, bodies redacted, AUTHOR kept (employer's data)
//
// A CONTACT IS SHARED ACROSS POSTINGS. One contact per email per company means
// anonymizing reaches every application that contact ever made at that company. That
// is correct — and it is why the confirmation UI must state the count first.

import { getContactForCompany } from '../../models/public/contact-model.js';
import {
  anonymizeContactForCompany, isContactAnonymized,
} from '../../models/public/contact-anonymization-model.js';
import {
  listApplicationsForContact, redactApplicationForCompany,
} from '../../models/public/application-model.js';
import {
  getResumeFileForApplication, redactResumeFileForApplication,
} from '../../models/public/resume-file-model.js';
import { redactNotesForApplication } from '../../models/public/applicant-note-model.js';
import { deleteResumeFile } from '../public/resume-storage-service.js';
import { appendAudit } from './audit-log-service.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';

/** Bytes off disk, then the row pointed at them. Missing files are not an error. */
async function eraseResumeFor(applicationId) {
  const resumeFile = await getResumeFileForApplication(applicationId);
  if (!resumeFile) return false;
  // Best-effort by contract: a file already swept by retention leaves nothing to
  // unlink, and that is the desired end state, not a failure.
  if (resumeFile.storagePath) deleteResumeFile(resumeFile.storagePath);
  await redactResumeFileForApplication(applicationId);
  return true;
}

/**
 * Anonymize one contact and everything hanging off it within one company.
 *
 * Idempotent. A contact that is already anonymized returns
 * { alreadyAnonymized: true } and writes nothing — running the erasure task twice,
 * or clicking the button twice, is a no-op rather than a second audit entry.
 *
 * Returns { contactAnonymized, applicationsProcessed, filesDeleted, notesRedacted }.
 */
export async function anonymizeCandidateForCompany(companyId, contactId, { actor } = {}) {
  const contact = await getContactForCompany(companyId, contactId);
  if (!contact) {
    return {
      contactAnonymized: false, alreadyAnonymized: false, notFound: true,
      applicationsProcessed: 0, filesDeleted: 0, notesRedacted: 0,
    };
  }
  if (isContactAnonymized(contact)) {
    return {
      contactAnonymized: true, alreadyAnonymized: true,
      applicationsProcessed: 0, filesDeleted: 0, notesRedacted: 0,
    };
  }

  const applications = await listApplicationsForContact(companyId, contact._id);
  let filesDeleted = 0;
  let notesRedacted = 0;

  for (const application of applications) {
    if (await eraseResumeFor(application._id)) filesDeleted += 1;
    notesRedacted += await redactNotesForApplication(companyId, application._id);
    await redactApplicationForCompany(companyId, application._id);
  }

  // The contact goes LAST: it carries the anonymized marker this function uses to
  // decide it has already run, so it must not flip until the rest actually did.
  await anonymizeContactForCompany(companyId, contact._id);

  const summary = {
    contactAnonymized: true,
    alreadyAnonymized: false,
    applicationsProcessed: applications.length,
    filesDeleted,
    notesRedacted,
  };

  await appendAudit({
    event: AUDIT_EVENTS.ERASURE_COMPLETED,
    actorType: actor?.type ?? 'system',
    actorId: actor?.id ?? null,
    targetType: 'contact',
    targetId: contact._id,
    metadata: { companyId: companyId?.toString() ?? null, ...summary },
  });

  return summary;
}
