// FILE: src/models/public/contact-do-not-contact-model.js
// The "do not contact" flag, on the contact rather than the application.
//
// ON THE CONTACT, DELIBERATELY. A contact is one person per company, so flagging
// them once covers every posting they have applied to and every one they will —
// which is the entire point. A per-application flag would have to be re-set each
// time the same person turned up, and would silently fail exactly when it mattered.
//
// IT IS NOT AN ARCHIVE. A flagged candidate stays in the pipeline where the team
// can see them; what changes is that the record now carries a visible warning, with
// who set it and why. Erasing them from view would defeat the purpose: the point is
// that the next recruiter to open this profile finds out BEFORE reaching out.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const contactsCol = () => col('contacts');

const MAXIMUM_REASON_LENGTH = 200;

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** The flag as clients read it. Absent on every row that was never flagged. */
export function toDoNotContact(stored) {
  return {
    flag: Boolean(stored?.flag),
    setAt: stored?.setAt ?? null,
    setBy: stored?.setBy ? stored.setBy.toString() : null,
    setByName: stored?.setByName ?? null,
    reason: stored?.reason ?? null,
  };
}

/** Trimmed reason, ≤200 chars. Anything empty is stored as null, never ''. */
export function normalizeDoNotContactReason(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAXIMUM_REASON_LENGTH);
}

/**
 * Set or clear the flag, scoped to the company (§6.5).
 *
 * Clearing wipes the whole sub-document rather than flipping flag to false: the
 * reason and the "set by" attribution describe a decision that has been reversed,
 * and leaving them behind would make an un-flagged contact still read as suspect in
 * any view that renders the reason without checking the flag first.
 */
export async function setDoNotContactForCompany(
  companyId, contactId, { flag, reason, setBy, setByName },
) {
  const companyOid = toOid(companyId);
  const contactOid = toOid(contactId);
  if (!companyOid || !contactOid) return null;

  const doNotContact = flag
    ? {
        flag: true,
        setAt: new Date(),
        setBy: toOid(setBy),
        // Snapshot, like a note's author: the record must still say who decided this
        // after that person leaves the company.
        setByName: setByName ?? null,
        reason: normalizeDoNotContactReason(reason),
      }
    : { flag: false, setAt: null, setBy: null, setByName: null, reason: null };

  const collection = await contactsCol();
  return collection.findOneAndUpdate(
    { _id: contactOid, companyId: companyOid },
    { $set: { doNotContact, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/** True when this contact must not be contacted. Safe on a row that lacks the field. */
export function isDoNotContact(contact) {
  return Boolean(contact?.doNotContact?.flag);
}
