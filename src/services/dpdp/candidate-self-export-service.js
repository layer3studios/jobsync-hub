// FILE: src/services/dpdp/candidate-self-export-service.js
// The DPDP right of access, for someone with no account.
//
// TWO STEPS, ON PURPOSE. Asking for the export and receiving it are separated by an
// email, because the request arrives from an unauthenticated stranger who has typed
// an address. Reading mail at that address is the only proof of ownership available,
// so the emailed link is the authentication step, not a convenience.
//
// THE REQUEST ENDPOINT NEVER SAYS WHETHER THE EMAIL EXISTS. Same response, same
// timing shape, whether or not there is a contact — otherwise this becomes a free
// oracle for "has this person applied to that company", which is exactly the kind of
// disclosure the regulation is about.
//
// The export itself is built with audience: 'candidate', which withholds internal
// notes, score reasoning and interviewer feedback. See candidate-export-service.

import { getCompanyBySlug } from '../../models/employer/company-model.js';
import { getContactByEmailForCompany } from '../../models/public/contact-model.js';
import { listApplicationsForContact } from '../../models/public/application-model.js';
import {
  createDataExportRequest, consumeDataExportRequest,
} from '../../models/dpdp/data-export-request-model.js';
import { FRONTEND_URL } from '../../env.js';
import { sendTransactionalEmail } from '../email/send-email-service.js';
import { buildDataExportLinkEmail } from '../email/templates/data-export-link-template.js';
import {
  buildCandidateExport, EXPORT_AUDIENCES,
} from '../employer/candidate-export-service.js';

/**
 * Step 1: verify by email. Always resolves the same way — the caller answers 202 with
 * a fixed message regardless of what happened here.
 */
export async function requestCandidateDataExport({ email, companySlug, ipAddress = null }) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail.includes('@')) return { accepted: true };

  const company = await getCompanyBySlug(String(companySlug ?? '').trim());
  if (!company) return { accepted: true };

  const contact = await getContactByEmailForCompany(company._id, normalizedEmail);
  if (!contact) return { accepted: true };

  const request = await createDataExportRequest({
    companyId: company._id, contactId: contact._id, email: normalizedEmail, ipAddress,
  });
  const downloadUrl = `${FRONTEND_URL}/privacy/export?token=${encodeURIComponent(request.token)}`;

  // Fire-and-forget by contract (sendTransactionalEmail never rejects). A mail
  // failure leaves an unused token that the TTL index will sweep.
  void sendTransactionalEmail({
    to: normalizedEmail,
    ...buildDataExportLinkEmail({ companyName: company.name, downloadUrl }),
  });

  return { accepted: true };
}

/**
 * Step 2: redeem the link. Returns { export } or null when the token is unknown,
 * expired or already used — the three are indistinguishable to the caller.
 *
 * A contact with several applications gets ONE document per application, because
 * each application is a distinct piece of processing with its own stage history and
 * interviews. Nothing is deduplicated away.
 */
export async function redeemCandidateDataExport(token) {
  const request = await consumeDataExportRequest(token);
  if (!request) return null;

  const applications = await listApplicationsForContact(request.companyId, request.contactId);
  const applicationExports = [];
  for (const application of applications) {
    applicationExports.push(await buildCandidateExport(request.companyId, application._id, {
      audience: EXPORT_AUDIENCES.CANDIDATE,
    }));
  }

  return {
    generatedAt: new Date(),
    email: request.email,
    applicationCount: applicationExports.length,
    applications: applicationExports,
  };
}
