// FILE: src/services/dpdp/erasure-service.js
// Fulfilment of a DPDP erasure right (Rule 14). rights-request-service takes the
// request in; this takes it out.
//
// A REQUEST IS MADE BY A PERSON, NOT BY A TENANT. rights_requests carries a contact
// email and no companyId, which is correct: the Data Principal is asking JobMesh to
// erase them, and their email may be a contact at several employers. So fulfilment
// fans out over every company where that email appears and anonymizes each one.
//
// The per-company work lives in anonymize-candidate-service; this file owns request
// state, the fan-out, and the summary.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  findRightsRequestById, markRightsRequestStatus,
} from '../../models/dpdp/rights-request-model.js';
import { RIGHTS_REQUEST_TYPES, RIGHTS_REQUEST_STATUSES } from '../../models/dpdp/dpdp-constants.js';
import { findContactsByEmailAcrossCompanies } from '../../models/public/contact-model.js';
import { anonymizeCandidateForCompany } from './anonymize-candidate-service.js';

const OPEN_STATUSES = [RIGHTS_REQUEST_STATUSES.SUBMITTED, RIGHTS_REQUEST_STATUSES.IN_PROGRESS];

/** Sum the per-company summaries into one line the caller can log or display. */
function totalise(results) {
  return results.reduce((running, result) => ({
    companiesProcessed: running.companiesProcessed + 1,
    applicationsProcessed: running.applicationsProcessed + result.applicationsProcessed,
    filesDeleted: running.filesDeleted + result.filesDeleted,
    notesRedacted: running.notesRedacted + result.notesRedacted,
  }), { companiesProcessed: 0, applicationsProcessed: 0, filesDeleted: 0, notesRedacted: 0 });
}

/**
 * Fulfil one erasure request end to end.
 *
 * Idempotent at the request level: an already-fulfilled request returns
 * { alreadyFulfilled: true } and touches nothing, so the SLA task can be run on a
 * cron without tracking what it has already seen.
 *
 * A request with NO matching contact still completes. The Data Principal asked us to
 * erase them and there is nothing of them to erase — leaving the request open would
 * misreport an unmet obligation as outstanding forever.
 */
export async function fulfillErasureRequest(rightsRequestId, { actor } = {}) {
  const request = await findRightsRequestById(rightsRequestId);
  if (!request) throw new HttpError(404, 'Rights request not found', 'RIGHTS_REQUEST_NOT_FOUND');
  if (request.requestType !== RIGHTS_REQUEST_TYPES.ERASURE) {
    throw new HttpError(400, 'This request is not an erasure request', 'NOT_AN_ERASURE_REQUEST');
  }
  if (!OPEN_STATUSES.includes(request.status)) {
    return { rightsRequestId: request._id.toString(), alreadyFulfilled: true, contactAnonymized: false };
  }

  const contacts = await findContactsByEmailAcrossCompanies(request.contactEmail);
  const results = [];
  for (const contact of contacts) {
    results.push(await anonymizeCandidateForCompany(contact.companyId, contact._id, {
      actor: actor ?? { type: 'system', id: null },
    }));
  }

  await markRightsRequestStatus(request._id, RIGHTS_REQUEST_STATUSES.FULFILLED, {
    fulfilledByAdminId: actor?.type === 'admin' ? actor.id : null,
  });

  return {
    rightsRequestId: request._id.toString(),
    alreadyFulfilled: false,
    contactAnonymized: results.some((result) => result.contactAnonymized),
    ...totalise(results),
  };
}

export default fulfillErasureRequest;
