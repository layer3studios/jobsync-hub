// FILE: tests/models/interview-validators.test.js
// Pure unit tests — no database, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateProposedSlots, validateInterviewMode, validateDurationMinutes, validateMeetingLocation,
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

test('validateMeetingLocation: video requires absolute http(s) meetingUrl', () => {
  const normalized = validateMeetingLocation(INTERVIEW_MODES.VIDEO, ' https://meet.jobmesh.in/x ', null);
  assert.deepEqual(normalized, { meetingUrl: 'https://meet.jobmesh.in/x', locationText: null });
  expectCode(() => validateMeetingLocation(INTERVIEW_MODES.VIDEO, null, 'Office'), INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
  expectCode(() => validateMeetingLocation(INTERVIEW_MODES.VIDEO, 'meet.jobmesh.in/x', null), INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
});

test('validateMeetingLocation: phone and in_person require locationText', () => {
  for (const mode of [INTERVIEW_MODES.PHONE, INTERVIEW_MODES.IN_PERSON]) {
    const normalized = validateMeetingLocation(mode, null, ' JobMesh HQ, Bengaluru ');
    assert.deepEqual(normalized, { meetingUrl: null, locationText: 'JobMesh HQ, Bengaluru' });
    expectCode(() => validateMeetingLocation(mode, 'https://meet.jobmesh.in/x', ''), INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
  }
});
