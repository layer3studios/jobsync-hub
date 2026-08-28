// FILE: src/models/dpdp/dpdp-constants.js
// DPDP enums — consent purposes/methods, rights-request types/statuses, and
// audit events. Frozen so they behave as read-only lookup tables.

export const CONSENT_PURPOSES = Object.freeze({
  PROFILE_STORAGE: 'profile_storage',       // save seeker profile
  RESUME_PARSING: 'resume_parsing',         // send resume to Gemma
  RESUME_MATCHING: 'resume_matching',       // match profile → jobs
  APPLY_TO_POSTING: 'apply_to_posting',     // share with one employer
  EMPLOYER_VIEW_PROFILE: 'employer_view_profile', // opt-in searchable
  RECRUITER_OUTREACH: 'recruiter_outreach', // let recruiters contact
  MARKETING: 'marketing',                   // JobMesh marketing emails
});

export const CONSENT_METHODS = Object.freeze({
  CHECKBOX: 'checkbox', SIGNUP: 'signup',
  APPLICATION: 'application', ADMIN: 'admin',
});

export const RIGHTS_REQUEST_TYPES = Object.freeze({
  ACCESS: 'access', CORRECTION: 'correction',
  ERASURE: 'erasure', GRIEVANCE: 'grievance',
});

export const RIGHTS_REQUEST_STATUSES = Object.freeze({
  SUBMITTED: 'submitted', IN_PROGRESS: 'in_progress',
  FULFILLED: 'fulfilled', REJECTED: 'rejected',
});

export const AUDIT_EVENTS = Object.freeze({
  CONSENT_GRANTED: 'consent_granted',
  CONSENT_WITHDRAWN: 'consent_withdrawn',
  RIGHTS_REQUEST_SUBMITTED: 'rights_request_submitted',
  RIGHTS_REQUEST_STATUS_CHANGED: 'rights_request_status_changed',
  DATA_ACCESSED: 'data_accessed',
  DATA_DELETED: 'data_deleted',
  // Fulfilment of an erasure right: the contact was anonymized and its resumes,
  // notes and request metadata were stripped. Distinct from DATA_DELETED, which
  // covers ordinary retention sweeps rather than a Data Principal's request.
  ERASURE_COMPLETED: 'erasure_completed',
  // Interview scheduling is a distinct processing activity on candidate
  // personal data (name, email, availability) and must leave an audit trail.
  INTERVIEW_PROPOSED: 'interview_proposed',
  INTERVIEW_RESCHEDULED: 'interview_rescheduled',
  INTERVIEW_CANCELLED: 'interview_cancelled',
  // Post-interview lifecycle: feedback and no-show are processing activities on
  // candidate data; the rejection email is candidate-facing communication.
  INTERVIEW_COMPLETED: 'interview_completed',
  INTERVIEW_NO_SHOW: 'interview_no_show',
  REJECTION_EMAIL_SENT: 'rejection_email_sent',
  // Admin-panel administration. These record who changed the platform's own
  // access and configuration — not processing of a Data Principal's data, but
  // the same append-only trail is the right home for them.
  ADMIN_INVITED: 'admin_invited',
  ADMIN_INVITE_ACCEPTED: 'admin_invite_accepted',
  INVITE_RESENT: 'invite_resent',
  INVITE_REVOKED: 'invite_revoked',
  ADMIN_DEACTIVATED: 'admin_deactivated',
  ADMIN_REACTIVATED: 'admin_reactivated',
  ADMIN_ROLE_CHANGED: 'admin_role_changed',
  EMPLOYER_SIGNUP_TOGGLED: 'employer_signup_toggled',
  WHITELIST_ENTRY_ADDED: 'whitelist_entry_added',
  WHITELIST_ENTRY_REMOVED: 'whitelist_entry_removed',
  FEATURE_FLAG_CHANGED: 'feature_flag_changed',
});

/** True when `value` is one of the frozen enum's values. */
export function isEnumValue(enumObject, value) {
  return Object.values(enumObject).includes(value);
}
