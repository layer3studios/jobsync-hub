// FILE: tests/services/build-interview-invite-ics.test.js
// Pure unit tests over real generated ICS output — no network, no database.
// The VTIMEZONE assertion is the most important one here: a TZID without a
// matching VTIMEZONE block makes Outlook render the event in UTC (5.5h off).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInterviewInviteIcs, buildInterviewCancelIcs,
} from '../../src/services/email/build-interview-invite-ics.js';
import { INTERVIEW_MODES } from '../../src/services/email/calendar-invite-constants.js';

function inviteInput(overrides = {}) {
  return {
    calendarUid: 'interview-64f0c0ffee@jobmesh.in',
    calendarSequence: 3,
    startAtUtc: new Date('2026-08-10T05:30:00Z'), // 11:00 IST
    durationMinutes: 45,
    timezoneId: 'Asia/Kolkata',
    mode: INTERVIEW_MODES.VIDEO,
    meetingUrl: 'https://meet.jobmesh.in/room/abc123',
    locationText: null,
    postingTitle: 'Backend Engineer',
    companyName: 'JobMesh',
    candidateName: 'Asha Rao',
    candidateEmail: 'asha@example.com',
    organizerName: 'Ravi Recruiter',
    organizerEmail: 'ravi@jobmesh.in',
    interviewerEmails: ['lead@jobmesh.in', 'peer@jobmesh.in'],
    descriptionLines: ['Join: https://meet.jobmesh.in/room/abc123', 'Questions? ravi@jobmesh.in'],
    ...overrides,
  };
}

/** Unfold RFC 5545 folded lines (CRLF followed by a single space or tab). */
function unfoldedLines(icsString) {
  return icsString.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
}

test('emits a VTIMEZONE block with TZID:Asia/Kolkata (Outlook UTC-shift guard)', () => {
  const output = buildInterviewInviteIcs(inviteInput());
  assert.ok(output.includes('BEGIN:VTIMEZONE'), 'missing VTIMEZONE — Outlook would render in UTC');
  assert.ok(output.includes('TZID:Asia/Kolkata'));
});

test('invite builder sets METHOD:REQUEST', () => {
  assert.ok(buildInterviewInviteIcs(inviteInput()).includes('METHOD:REQUEST'));
});

test('cancel builder sets METHOD:CANCEL and STATUS:CANCELLED', () => {
  const output = buildInterviewCancelIcs(inviteInput({ calendarSequence: 4 }));
  assert.ok(output.includes('METHOD:CANCEL'));
  assert.ok(output.includes('STATUS:CANCELLED'));
});

test('every line break is CRLF — no bare LF anywhere', () => {
  const output = buildInterviewInviteIcs(inviteInput());
  assert.equal(output.replace(/\r\n/g, '').includes('\n'), false);
});

test('UID and SEQUENCE match the input', () => {
  const lines = unfoldedLines(buildInterviewInviteIcs(inviteInput()));
  assert.ok(lines.includes('UID:interview-64f0c0ffee@jobmesh.in'));
  assert.ok(lines.includes('SEQUENCE:3'));
});

test('commas in locationText are escaped', () => {
  const output = buildInterviewInviteIcs(inviteInput({
    mode: INTERVIEW_MODES.IN_PERSON,
    locationText: 'WeWork, Koramangala, Bengaluru',
  }));
  assert.ok(unfoldedLines(output).some((line) => line === 'LOCATION:WeWork\\, Koramangala\\, Bengaluru'));
});

test('candidate is an ATTENDEE with RSVP=TRUE', () => {
  const attendeeLine = unfoldedLines(buildInterviewInviteIcs(inviteInput()))
    .find((line) => line.startsWith('ATTENDEE') && line.includes('asha@example.com'));
  assert.ok(attendeeLine, 'candidate attendee missing');
  assert.ok(attendeeLine.includes('RSVP=TRUE'));
});

test('every interviewerEmail appears as an ATTENDEE', () => {
  const lines = unfoldedLines(buildInterviewInviteIcs(inviteInput()));
  for (const interviewerEmail of ['lead@jobmesh.in', 'peer@jobmesh.in']) {
    assert.ok(lines.some((line) => line.startsWith('ATTENDEE') && line.includes(interviewerEmail)));
  }
});

test('video mode puts meetingUrl in LOCATION; in_person mode puts locationText there', () => {
  const videoLines = unfoldedLines(buildInterviewInviteIcs(inviteInput()));
  assert.ok(videoLines.some((line) => line.startsWith('LOCATION:') && line.includes('meet.jobmesh.in')));
  const inPersonLines = unfoldedLines(buildInterviewInviteIcs(inviteInput({
    mode: INTERVIEW_MODES.IN_PERSON, locationText: 'JobMesh HQ', meetingUrl: null,
  })));
  assert.ok(inPersonLines.includes('LOCATION:JobMesh HQ'));
});

test('no content line exceeds 75 octets before the CRLF (measured in bytes)', () => {
  const output = buildInterviewInviteIcs(inviteInput({
    descriptionLines: ['A deliberately long ✨ description line — '.repeat(6), 'https://meet.jobmesh.in/room/abc123'],
  }));
  for (const line of output.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line over 75 octets: ${line}`);
  }
});

test('DTSTART carries TZID=Asia/Kolkata and is not a bare UTC Z value', () => {
  const dtstartLine = unfoldedLines(buildInterviewInviteIcs(inviteInput()))
    .find((line) => line.startsWith('DTSTART;'));
  assert.ok(dtstartLine, 'event DTSTART with parameters missing');
  assert.ok(dtstartLine.startsWith('DTSTART;TZID=Asia/Kolkata:'));
  assert.ok(!dtstartLine.endsWith('Z'));
  assert.ok(dtstartLine.includes('20260810T110000'), 'expected 11:00 IST local time');
});

test('DTSTAMP is UTC with a trailing Z (RFC 5545 §3.8.7.2)', () => {
  const dtstampLine = unfoldedLines(buildInterviewInviteIcs(inviteInput()))
    .find((line) => line.startsWith('DTSTAMP'));
  assert.match(dtstampLine, /^DTSTAMP:\d{8}T\d{6}Z$/);
});

test('DTSTART and DTEND stay TZID-qualified with no Z (the opposite rule to DTSTAMP)', () => {
  const lines = unfoldedLines(buildInterviewInviteIcs(inviteInput()));
  for (const prefix of ['DTSTART;', 'DTEND;']) {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    assert.ok(line, `${prefix} line missing`);
    assert.ok(line.includes('TZID=Asia/Kolkata'), `${prefix} lost its TZID`);
    assert.ok(!line.endsWith('Z'), `${prefix} must not be UTC`);
  }
});

test('identical input produces identical output (deterministic folding)', () => {
  // DTSTAMP is legitimately "now", so it is normalized before comparing; every
  // other byte — including folding positions — must be identical across calls.
  const normalize = (icsString) => icsString.replace(/^DTSTAMP:.*$/m, 'DTSTAMP:NORMALIZED');
  const first = normalize(buildInterviewInviteIcs(inviteInput()));
  const second = normalize(buildInterviewInviteIcs(inviteInput()));
  assert.equal(first, second);
});
