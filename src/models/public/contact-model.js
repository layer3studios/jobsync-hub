// FILE: src/models/public/contact-model.js
// contacts collection — Lever's Contact: one person per company, deduped by email
// (R1/§5.4). Every query is companyId-scoped (§6.5). A candidate applying to three
// jobs at one company = three applications, one contact.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const contactsCol = () => col('contacts');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureContactIndexes() {
  const collection = await contactsCol();
  await collection.createIndex({ companyId: 1, email: 1 }, { unique: true, name: 'contacts_companyId_email' });
}

/** Find the company's contact for this email, or create one. Retries on E11000 race. */
export async function findOrCreateContactForCompany(companyId, { email, fullName, phone, linkedinUrl, location } = {}) {
  const companyOid = toOid(companyId);
  if (!companyOid) throw new Error('findOrCreateContactForCompany: invalid companyId');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const collection = await contactsCol();

  const existing = await collection.findOne({ companyId: companyOid, email: normalizedEmail });
  if (existing) return { contact: existing, isNew: false };

  const now = new Date();
  const doc = {
    companyId: companyOid, email: normalizedEmail,
    fullName: fullName ?? null, phone: phone ?? null,
    linkedinUrl: linkedinUrl ?? null, location: location ?? null,
    firstSeenAt: now, createdAt: now, updatedAt: now,
  };
  try {
    const result = await collection.insertOne(doc);
    return { contact: { ...doc, _id: result.insertedId }, isNew: true };
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await collection.findOne({ companyId: companyOid, email: normalizedEmail });
      if (raced) return { contact: raced, isNew: false };
    }
    throw err;
  }
}

/** Fetch one contact, scoped to the company — cross-tenant lookups return null. */
export async function getContactForCompany(companyId, contactId) {
  const companyOid = toOid(companyId);
  const contactOid = toOid(contactId);
  if (!companyOid || !contactOid) return null;
  const collection = await contactsCol();
  return collection.findOne({ _id: contactOid, companyId: companyOid });
}

/** Client-safe projection — id as string. */
export function toPublicContact(doc) {
  return {
    id: doc._id.toString(),
    email: doc.email,
    fullName: doc.fullName ?? null,
    phone: doc.phone ?? null,
    linkedinUrl: doc.linkedinUrl ?? null,
    location: doc.location ?? null,
    firstSeenAt: doc.firstSeenAt,
  };
}
