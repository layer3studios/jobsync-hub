// FILE: src/models/employer/employer-user-profile-model.js
// The employer user's OWN settings: timezone, job title, uploaded avatar, and
// notification preferences. Split out of employer-user-model, which owns identity —
// the fields Google gives us and we never let the user edit.
//
// EVERY FIELD HERE IS ABSENT ON EXISTING ROWS. Nothing backfills; every reader
// defaults instead. That is why the projection below applies defaults rather than
// the writer applying them at signup: a user who has never opened this page has no
// preferences document, and "no document" has to mean "everything on".

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const employerUsersCol = () => col('employer_users');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** India is where these companies hire, so it is the default rather than UTC. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const MAXIMUM_JOB_TITLE_LENGTH = 60;

/**
 * The eight events a teammate can be emailed about, with their defaults.
 *
 * ALL TRUE. A new teammate is notified about everything and turns off what turns out
 * to be noise — the opposite default would mean someone silently missing an @mention
 * for weeks because they never found this page.
 */
export const NOTIFICATION_EVENTS = Object.freeze({
  newApplication: true,
  stageChange: true,
  noteMention: true,
  interviewScheduled: true,
  interviewReminder: true,
  feedbackSubmitted: true,
  candidateHired: true,
  applicationDeadline: true,
});

export const NOTIFICATION_EVENT_KEYS = Object.freeze(Object.keys(NOTIFICATION_EVENTS));

/** Defaults merged over whatever the row happens to carry. Unknown keys are dropped. */
export function toNotificationPreferences(stored) {
  const result = { ...NOTIFICATION_EVENTS };
  for (const key of NOTIFICATION_EVENT_KEYS) {
    if (typeof stored?.[key] === 'boolean') result[key] = stored[key];
  }
  return result;
}

/** The settings half of an employer user, defaults applied. */
export function toEmployerUserProfile(user) {
  return {
    timezone: user?.timezone || DEFAULT_TIMEZONE,
    jobTitle: user?.jobTitle ?? null,
    // The uploaded override. Distinct from `picture`, which is Google's and can
    // rotate its URL out from under us at any time.
    avatarUrl: user?.avatarUrl ?? null,
    notificationPreferences: toNotificationPreferences(user?.notificationPreferences),
  };
}

/** Apply a validated patch. Returns the updated doc, or null when the user is gone. */
export async function updateEmployerUserProfile(employerUserId, patch) {
  const oid = toOid(employerUserId);
  if (!oid || Object.keys(patch).length === 0) return null;
  const collection = await employerUsersCol();
  return collection.findOneAndUpdate(
    { _id: oid },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

/**
 * Merge a partial notification patch into whatever is stored.
 *
 * Dot-path $set rather than replacing the whole object: two tabs toggling different
 * switches must not overwrite each other, and a client that sends one key must not
 * silently reset the other seven to their defaults.
 */
export async function mergeNotificationPreferences(employerUserId, partial) {
  const oid = toOid(employerUserId);
  if (!oid) return null;
  const set = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(partial)) {
    set[`notificationPreferences.${key}`] = value;
  }
  const collection = await employerUsersCol();
  return collection.findOneAndUpdate({ _id: oid }, { $set: set }, { returnDocument: 'after' });
}
