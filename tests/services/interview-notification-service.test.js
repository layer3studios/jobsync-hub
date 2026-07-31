// FILE: tests/services/interview-notification-service.test.js
// Pure unit tests with a fake sendEmail — no network, no database. Guards the
// attachment contract: invitation attaches NOTHING; confirmations and cancels
// attach exactly ONE .ics with the calendar contentType.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sendInterviewInvitationEmail, sendInterviewConfirmationEmails, sendInterviewCancelledEmails,
} from '../../src/services/interview/interview-notification-service.js';
import { CALENDAR_INVITE_CONTENT_TYPE } from '../../src/services/email/email-constants.js';
import { INTERVIEW_MODES } from '../../src/services/email/calendar-invite-constants.js';

function fakeSender() {
  const messages = [];
  const sendEmail = async (message) => { messages.push(message); return { sent: true, code: null, emailId: 'e1' }; };
  return { messages, sendEmail };
}

function context(interviewOverrides = {}) {
  return {
    interview: {
      calendarUid: 'interview-abc@jobmesh.in',
      calendarSequence: 1,
      status: 'scheduled',
      proposedSlots: [{ startAtUtc: new Date('2026-08-10T05:30:00Z'), durationMinutes: 45 }],
      startAtUtc: new Date('2026-08-10T05:30:00Z'),
      durationMinutes: 45,
      timezoneId: 'Asia/Kolkata',
      mode: INTERVIEW_MODES.VIDEO,
      meetingUrl: 'https://meet.jobmesh.in/room/abc',
      locationText: null,
      bookingToken: 'token-abc',
      bookingTokenExpiresAt: new Date('2026-08-07T00:00:00Z'),
      cancelReason: null,
      ...interviewOverrides,
    },
    companyName: 'JobMesh',
    postingTitle: 'Backend Engineer',
    candidateName: 'Asha Rao',
    candidateEmail: 'asha@example.com',
    organizerName: 'Ravi Recruiter',
    organizerEmail: 'ravi@jobmesh.in',
    interviewerEmails: ['lead@jobmesh.in', 'peer@jobmesh.in'],
  };
}

function decodeIcs(attachment) {
  return Buffer.from(attachment.content, 'base64').toString('utf8');
}

test('invitation email has NO attachment', async () => {
  const { messages, sendEmail } = fakeSender();
  const summary = await sendInterviewInvitationEmail(context({ status: 'proposed' }), { sendEmail });
  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(messages[0].attachments, undefined);
  assert.ok(messages[0].html.includes('/interview/token-abc'));
});

test('confirmation sends exactly one .ics per recipient with the calendar contentType', async () => {
  const { messages, sendEmail } = fakeSender();
  const summary = await sendInterviewConfirmationEmails(context(), { sendEmail });
  assert.deepEqual(summary, { attempted: 3, sent: 3, failed: 0 });
  assert.deepEqual(messages.map((m) => m.to), ['asha@example.com', 'lead@jobmesh.in', 'peer@jobmesh.in']);
  for (const message of messages) {
    assert.equal(message.attachments.length, 1, 'exactly ONE attachment');
    assert.equal(message.attachments[0].contentType, CALENDAR_INVITE_CONTENT_TYPE);
    assert.equal(message.attachments[0].filename, 'interview.ics');
    const ics = decodeIcs(message.attachments[0]);
    assert.ok(ics.includes('METHOD:REQUEST'));
    assert.ok(ics.includes('UID:interview-abc@jobmesh.in'));
    assert.ok(ics.includes('Join the call: https://meet.jobmesh.in/room/abc'), 'meeting url must be in DESCRIPTION');
  }
});

test('cancel .ics has METHOD:CANCEL and a sequence greater than the invite', async () => {
  const confirmation = fakeSender();
  await sendInterviewConfirmationEmails(context({ calendarSequence: 1 }), { sendEmail: confirmation.sendEmail });
  const inviteIcs = decodeIcs(confirmation.messages[0].attachments[0]);
  assert.ok(inviteIcs.includes('SEQUENCE:1'));

  const cancel = fakeSender();
  const summary = await sendInterviewCancelledEmails(
    context({ calendarSequence: 2, status: 'cancelled', cancelReason: 'Position filled' }),
    { sendEmail: cancel.sendEmail },
  );
  assert.deepEqual(summary, { attempted: 3, sent: 3, failed: 0 });
  const cancelIcs = decodeIcs(cancel.messages[0].attachments[0]);
  assert.ok(cancelIcs.includes('METHOD:CANCEL'));
  assert.ok(cancelIcs.includes('STATUS:CANCELLED'));
  assert.ok(cancelIcs.includes('SEQUENCE:2'), 'cancel sequence must exceed the invite sequence');
  assert.equal(cancel.messages[0].attachments.length, 1);
});

test('a failed send is tallied, not thrown', async () => {
  const sendEmail = async () => ({ sent: false, code: 'SEND_FAILED', emailId: null });
  const summary = await sendInterviewConfirmationEmails(context(), { sendEmail });
  assert.deepEqual(summary, { attempted: 3, sent: 0, failed: 3 });
});
