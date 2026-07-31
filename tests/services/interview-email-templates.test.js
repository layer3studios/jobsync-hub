// FILE: tests/services/interview-email-templates.test.js
// Pure template tests — no network, no database. Guards the Outlook-safe rules:
// table layout, both html AND text, no flexbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInterviewInvitationEmail } from '../../src/services/email/templates/interview-invitation-template.js';
import {
  buildCandidateConfirmationEmail, buildInterviewerConfirmationEmail,
} from '../../src/services/email/templates/interview-confirmation-template.js';
import { buildInterviewCancelledEmail } from '../../src/services/email/templates/interview-cancelled-template.js';
import { INTERVIEW_MODES } from '../../src/services/email/calendar-invite-constants.js';

const START_AT_UTC = new Date('2026-08-10T09:30:00Z');

const shared = {
  candidateName: 'Asha Rao',
  companyName: 'JobMesh',
  postingTitle: 'Backend Engineer',
  timezoneId: 'Asia/Kolkata',
  durationMinutes: 45,
  mode: INTERVIEW_MODES.VIDEO,
  meetingUrl: 'https://meet.jobmesh.in/room/abc',
  locationText: null,
  organizerEmail: 'ravi@jobmesh.in',
};

function allTemplates() {
  return [
    ['invitation', buildInterviewInvitationEmail({
      ...shared,
      proposedSlots: [
        { startAtUtc: START_AT_UTC, durationMinutes: 45 },
        { startAtUtc: new Date('2026-08-11T09:30:00Z'), durationMinutes: 45 },
      ],
      bookingUrl: 'https://jobmesh.in/interview/token123',
      expiresAt: new Date('2026-08-07T09:30:00Z'),
    })],
    ['candidate confirmation', buildCandidateConfirmationEmail({ ...shared, startAtUtc: START_AT_UTC })],
    ['interviewer confirmation', buildInterviewerConfirmationEmail({
      ...shared, candidateEmail: 'asha@example.com', startAtUtc: START_AT_UTC,
    })],
    ['cancelled', buildInterviewCancelledEmail({ ...shared, startAtUtc: START_AT_UTC, cancelReason: 'Position filled' })],
  ];
}

test('every template returns non-empty html AND text, table layout, no flexbox', () => {
  for (const [label, { subject, html, text }] of allTemplates()) {
    assert.ok(subject.length > 0, `${label}: empty subject`);
    assert.ok(html.length > 0, `${label}: empty html`);
    assert.ok(text.length > 0, `${label}: empty text`);
    assert.ok(html.includes('<table'), `${label}: not table-based`);
    assert.ok(!html.includes('<div style="display:flex'), `${label}: flexbox layout`);
    assert.ok(html.length < 100 * 1024, `${label}: over 100KB, Gmail will clip`);
  }
});

test('invitation lists each slot in IST, states expiry, never includes meetingUrl', () => {
  const [, invitation] = allTemplates()[0];
  assert.ok(invitation.text.includes('Option 1: Monday, 10 August 2026 at 3:00 PM IST (45 minutes)'));
  assert.ok(invitation.text.includes('Option 2:'));
  assert.ok(invitation.text.includes('7 August 2026'));
  assert.ok(!invitation.html.includes('meet.jobmesh.in/room'), 'meetingUrl leaked before booking');
  assert.ok(invitation.html.includes('jobmesh.in/interview/token123'));
});

test('candidate confirmation carries the meeting url; in_person carries location', () => {
  const video = buildCandidateConfirmationEmail({ ...shared, startAtUtc: START_AT_UTC });
  assert.ok(video.text.includes('https://meet.jobmesh.in/room/abc'));
  const inPerson = buildCandidateConfirmationEmail({
    ...shared, mode: INTERVIEW_MODES.IN_PERSON, meetingUrl: null,
    locationText: 'JobMesh HQ, Bengaluru', startAtUtc: START_AT_UTC,
  });
  assert.ok(inPerson.text.includes('JobMesh HQ, Bengaluru'));
});
