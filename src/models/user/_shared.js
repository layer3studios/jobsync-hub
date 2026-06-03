// FILE: src/models/user/_shared.js
// Internal helpers shared across user/* modules. Not re-exported from the barrel.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

/** Returns true if id is a non-empty string and valid ObjectId. */
export function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && ObjectId.isValid(id);
}

/** Convert a string id to ObjectId. Returns null if invalid. */
export function toOid(id) {
  return isValidId(id) ? new ObjectId(id) : null;
}

/** Get the users collection. */
export const usersCol = () => col('users');

/**
 * Normalise the legacy appliedJobs array.
 * Old format stored bare strings; new format stores rich entries.
 */
export function normaliseApplied(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => {
    if (typeof entry === 'string') {
      return {
        jobId: entry,
        appliedAt: new Date(0),
        jobTitle: null, company: null, applicationURL: null,
        location: null, department: null,
        stage: 'applied', stageUpdatedAt: new Date(0),
      };
    }
    return {
      jobId: entry.jobId,
      appliedAt: entry.appliedAt || new Date(0),
      jobTitle: entry.jobTitle || null,
      company: entry.company || null,
      applicationURL: entry.applicationURL || null,
      location: entry.location || null,
      department: entry.department || null,
      stage: entry.stage || 'applied',
      stageUpdatedAt: entry.stageUpdatedAt || entry.appliedAt || new Date(0),
    };
  });
}

export const VALID_STAGES = [
  'applied', 'screening', 'interview', 'offer', 'accepted', 'rejected', 'ghosted',
];
