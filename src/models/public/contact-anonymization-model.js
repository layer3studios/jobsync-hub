// FILE: src/models/public/contact-anonymization-model.js
// DPDP erasure writes against the contacts collection. Split out of contact-model
// so the everyday read/write path is not read alongside a destructive one.
//
// THE CONTACT ROW SURVIVES; the person inside it does not. Aggregate reporting
// (applications per posting, funnel conversion) counts contacts, so deleting one
// would silently rewrite last quarter's numbers. Every identifying field is
// overwritten in place instead.
//
// The synthetic email keeps the unique (companyId, email) index satisfied for any
// number of anonymized contacts, and doubles as the marker that tells a second run
// there is nothing left to do.

import { col } from '../../Db/connection.js';
import { getContactForCompany } from './contact-model.js';

const contactsCol = () => col('contacts');

export const ANONYMIZED_PLACEHOLDER = '[Anonymized]';
const ANONYMIZED_EMAIL_DOMAIN = 'anonymized.local';

/** The one address this contact can safely hold. Derived, so it is stable. */
export function anonymizedEmailFor(contactId) {
  return `anon-${contactId.toString()}@${ANONYMIZED_EMAIL_DOMAIN}`;
}

/** True once this contact has been through erasure — the idempotency check. */
export function isContactAnonymized(doc) {
  return typeof doc?.email === 'string' && doc.email.endsWith(`@${ANONYMIZED_EMAIL_DOMAIN}`);
}

/**
 * Strip every identifying field from one contact. Returns the updated doc, or null
 * when the contact does not exist for this company. Re-running is harmless: the
 * second write sets the same values the first one did.
 */
export async function anonymizeContactForCompany(companyId, contactId) {
  const current = await getContactForCompany(companyId, contactId);
  if (!current) return null;
  const now = new Date();
  const collection = await contactsCol();
  await collection.updateOne(
    { _id: current._id, companyId: current.companyId },
    { $set: {
      fullName: ANONYMIZED_PLACEHOLDER,
      email: anonymizedEmailFor(current._id),
      phone: null, linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null,
      anonymizedAt: current.anonymizedAt ?? now,
      updatedAt: now,
    } },
  );
  return getContactForCompany(companyId, current._id);
}
