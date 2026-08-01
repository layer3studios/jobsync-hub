// FILE: tests/models/interview-validators.test.js
// Pure unit tests — no database, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateProposedSlots, validateInterviewMode, validateDurationMinutes, validateMeetingLocation,
  requireSendableVideoLink,
} from '../../src/models/interview/interview-validators.js';
import { INTERVIEW_ERROR_CODES, INTERVIEW_MODES } from '../../src/models/interview/interview-constants.js';

const HOURS_FROM_NOW = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);
const slot = (hours, durationMinutes = 45) => ({ startAtUtc: HOURS_FROM_NOW(hours), durationMinutes });

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, code);
    return true;
  });
}

test('validateProposedSlots accepts 2-4 distinct future slots', () => {
  assert.ok(validateProposedSlots([slot(24), slot(48)]));
  assert.ok(validateProposedSlots([slot(24), slot(48), slot(72), slot(96)]));
});

test('validateProposedSlots rejects too few / too many', () => {
  expectCode(() => validateProposedSlots([slot(24)]), INTERVIEW_ERROR_CODES.TOO_FEW_SLOTS);
  expectCode(() => validateProposedSlots([]), INTERVIEW_ERROR_CODES.TOO_FEW_SLOTS);
  expectCode(
    () => validateProposedSlots([slot(24), slot(48), slot(72), slot(96), slot(120)]),
    INTERVIEW_ERROR_CODES.TOO_MANY_SLOTS,
  );
});

test('validateProposedSlots rejects past, malformed, and duplicate slots', () => {
  expectCode(() => validateProposedSlots([slot(-1), slot(48)]), INTERVIEW_ERROR_CODES.INVALID_SLOT);
  expectCode(
    () => validateProposedSlots([{ startAtUtc: 'tomorrow', durationMinutes: 45 }, slot(48)]),
    INTERVIEW_ERROR_CODES.INVALID_SLOT,
  );
  expectCode(() => validateProposedSlots([slot(24, 0), slot(48)]), INTERVIEW_ERROR_CODES.INVALID_SLOT);
  const startAtUtc = HOURS_FROM_NOW(24);
  expectCode(
    () => validateProposedSlots([{ startAtUtc, durationMinutes: 45 }, { startAtUtc, durationMinutes: 45 }]),
    INTERVIEW_ERROR_CODES.INVALID_SLOT,
  );
});

test('validateInterviewMode accepts each known mode, rejects others', () => {
  for (const mode of Object.values(INTERVIEW_MODES)) assert.equal(validateInterviewMode(mode), mode);
  expectCode(() => validateInterviewMode('carrier_pigeon'), INTERVIEW_ERROR_CODES.INVALID_MODE);
  expectCode(() => validateInterviewMode(undefined), INTERVIEW_ERROR_CODES.INVALID_MODE);
});

test('validateDurationMinutes bounds: 15-480 inclusive, integers only', () => {
  assert.equal(validateDurationMinutes(15), 15);
  assert.equal(validateDurationMinutes(480), 480);
  expectCode(() => validateDurationMinutes(14), INTERVIEW_ERROR_CODES.INVALID_DURATION);
  expectCode(() => validateDurationMinutes(481), INTERVIEW_ERROR_CODES.INVALID_DURATION);
  expectCode(() => validateDurationMinutes(45.5), INTERVIEW_ERROR_CODES.INVALID_DURATION);
  expectCode(() => validateDurationMinutes('45'), INTERVIEW_ERROR_CODES.INVALID_DURATION);
});

test('validateMeetingLocation: video validates a supplied meetingUrl', () => {
  const normalized = validateMeetingLocation(INTERVIEW_MODES.VIDEO, ' https://meet.jobmesh.in/x ', null);
  assert.equal(normalized.meetingUrl, 'https://meet.jobmesh.in/x');
  assert.equal(normalized.locationText, null);
  assert.equal(normalized.phoneNumber, null);
  // A malformed link is still rejected — optional does not mean unvalidated.
  expectCode(() => validateMeetingLocation(INTERVIEW_MODES.VIDEO, 'meet.jobmesh.in/x', null), INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
});

test('validateMeetingLocation: video meetingUrl is OPTIONAL (per-date link flow)', () => {
  // Saving type + duration with no link yet must succeed: the link is entered
  // per date on each interview_times doc.
  for (const empty of [null, undefined, '', '   ']) {
    const normalized = validateMeetingLocation(INTERVIEW_MODES.VIDEO, empty, null);
    assert.equal(normalized.meetingUrl, null);
  }
});

test('requireSendableVideoLink: enforced at SEND time, not on defaults', () => {
  assert.equal(requireSendableVideoLink(INTERVIEW_MODES.VIDEO, ' https://meet.jobmesh.in/x '), 'https://meet.jobmesh.in/x');
  assert.equal(requireSendableVideoLink(INTERVIEW_MODES.PHONE, null), null); // non-video: no link needed
  expectCode(() => requireSendableVideoLink(INTERVIEW_MODES.VIDEO, null), INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
});

test('validateMeetingLocation: phone requires phoneNumber + phoneCallDirection', () => {
  const normalized = validateMeetingLocation(INTERVIEW_MODES.PHONE, null, null, {
    phoneNumber: ' +91 98765 43210 ', phoneCallDirection: 'we_call',
  });
  assert.equal(normalized.phoneNumber, '+91 98765 43210');
  assert.equal(normalized.phoneCallDirection, 'we_call');
  assert.equal(normalized.locationText, null);
  expectCode(() => validateMeetingLocation(INTERVIEW_MODES.PHONE, null, null, { phoneCallDirection: 'we_call' }), INTERVIEW_ERROR_CODES.INVALID_PHONE_DETAILS);
  expectCode(() => validateMeetingLocation(INTERVIEW_MODES.PHONE, null, null, { phoneNumber: '+91 1' }), INTERVIEW_ERROR_CODES.INVALID_PHONE_DETAILS);
});

test('validateMeetingLocation: in_person requires locationText; instructions optional', () => {
  const normalized = validateMeetingLocation(INTERVIEW_MODES.IN_PERSON, null, ' JobMesh HQ, Bengaluru ', {
    arrivalInstructions: ' Ask for Ashish at reception ',
  });
  assert.equal(normalized.locationText, 'JobMesh HQ, Bengaluru');
  assert.equal(normalized.arrivalInstructions, 'Ask for Ashish at reception');
  expectCode(() => validateMeetingLocation(INTERVIEW_MODES.IN_PERSON, 'https://meet.jobmesh.in/x', ''), INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
});
