// FILE: tests/services/interview-type-emails.test.js
// Type-aware interview emails, .ics location and mode validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCandidateConfirmationEmail } from '../../src/services/email/templates/interview-confirmation-template.js';
import { buildInterviewInviteIcs } from '../../src/services/email/build-interview-invite-ics.js';
import { validateMeetingLocation } from '../../src/models/interview/interview-validators.js';
import { INTERVIEW_ERROR_CODES } from '../../src/models/interview/interview-constants.js';

const START = new Date('2026-08-10T04:00:00.000Z');

function confirmation(overrides = {}) {
  return buildCandidateConfirmationEmail({
    candidateName: 'Ada', companyName: 'Acme', postingTitle: 'React Dev',
    startAtUtc: START, timezoneId: 'Asia/Kolkata', durationMinutes: 45,
    organizerEmail: 'hr@acme.in', mode: 'video', meetingUrl: 'https://meet.acme.in/x',
    locationText: null, arrivalInstructions: null, phoneNumber: null,
    phoneCallDirection: null, candidatePhone: null, ...overrides,
  });
}

function icsInput(overrides = {}) {
  return {
    calendarUid: 'uid-1@jobmesh.in', calendarSequence: 0, startAtUtc: START,
    durationMinutes: 45, timezoneId: 'Asia/Kolkata', mode: 'video',
    meetingUrl: 'https://meet.acme.in/x', locationText: null,
    postingTitle: 'React Dev', companyName: 'Acme', candidateName: 'Ada',
    candidateEmail: 'ada@x.io', organizerName: 'Acme', organizerEmail: 'hr@acme.in',
    interviewerEmails: [], descriptionLines: ['line'], ...overrides,
  };
}

test('video confirmation contains the meeting link', () => {
  const email = confirmation();
  assert.ok(email.text.includes('Join here: https://meet.acme.in/x'));
});

test("phone (we_call) confirmation says 'We will call you' at the candidate's number", () => {
  const email = confirmation({
    mode: 'phone', meetingUrl: null, phoneNumber: '+91 11111',
    phoneCallDirection: 'we_call', candidatePhone: '+91 99999',
  });
  assert.ok(email.text.includes('We will call you at +91 99999'));
});

test('phone (we_call) with no candidate phone asks for one instead', () => {
  const email = confirmation({
    mode: 'phone', meetingUrl: null, phoneNumber: '+91 11111',
    phoneCallDirection: 'we_call', candidatePhone: null,
  });
  assert.ok(email.text.includes('Please reply with your phone number so we can reach you.'));
});

test("phone (candidate_calls) confirmation says 'Please call us at' the interviewer's number", () => {
  const email = confirmation({
    mode: 'phone', meetingUrl: null, phoneNumber: '+91 11111',
    phoneCallDirection: 'candidate_calls', candidatePhone: '+91 99999',
  });
  assert.ok(email.text.includes('Please call us at +91 11111'));
});

test('in-person confirmation contains the address and an encoded Google Maps link', () => {
  const email = confirmation({
    mode: 'in_person', meetingUrl: null, locationText: 'JobMesh HQ, MG Road, Bengaluru',
  });
  assert.ok(email.text.includes('Location: JobMesh HQ, MG Road, Bengaluru'));
  assert.ok(email.text.includes(
    `Open in Google Maps: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('JobMesh HQ, MG Road, Bengaluru')}`,
  ));
});

test('in-person confirmation includes arrival instructions when present', () => {
  const email = confirmation({
    mode: 'in_person', meetingUrl: null, locationText: 'JobMesh HQ',
    arrivalInstructions: 'Ask for Ashish at reception, parking in basement',
  });
  assert.ok(email.text.includes('Ask for Ashish at reception, parking in basement'));
});

test('in-person confirmation omits arrival instructions when absent', () => {
  const email = confirmation({ mode: 'in_person', meetingUrl: null, locationText: 'JobMesh HQ' });
  assert.ok(!email.text.includes('reception'));
  const locationIndex = email.text.indexOf('Location: JobMesh HQ');
  const mapsIndex = email.text.indexOf('Open in Google Maps');
  assert.ok(locationIndex >= 0 && mapsIndex > locationIndex); // maps follows the address directly
});

test('.ics LOCATION for video is the meeting URL', () => {
  const ics = buildInterviewInviteIcs(icsInput());
  assert.match(ics, /LOCATION:https:\/\/meet\.acme\.in\/x/);
});

test('.ics LOCATION for in-person is the address', () => {
  const ics = buildInterviewInviteIcs(icsInput({ mode: 'in_person', meetingUrl: null, locationText: 'JobMesh HQ Bengaluru' }));
  assert.match(ics, /LOCATION:JobMesh HQ Bengaluru/);
});

test(".ics LOCATION for phone is 'Phone call'", () => {
  const ics = buildInterviewInviteIcs(icsInput({ mode: 'phone', meetingUrl: null, locationText: null }));
  assert.match(ics, /LOCATION:Phone call/);
});

test('phone mode without phoneNumber is rejected by validation', () => {
  assert.throws(
    () => validateMeetingLocation('phone', null, null, { phoneCallDirection: 'we_call' }),
    (err) => err.code === INTERVIEW_ERROR_CODES.INVALID_PHONE_DETAILS,
  );
});

test('in-person mode without locationText is rejected by validation', () => {
  assert.throws(
    () => validateMeetingLocation('in_person', null, null, {}),
    (err) => err.code === INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION,
  );
});
