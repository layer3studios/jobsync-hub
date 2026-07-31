// FILE: src/scripts/verify-calendar-invite-email.js
// One-off manual verification of calendar-invite rendering across mail clients
// (Gmail, Outlook, Apple Mail). Generates the invite through the real chunk-2
// builder (buildInterviewInviteIcs) with a comma in the location and the meeting
// URL in the description lines, so a real send exercises escaping and the
// Outlook-hides-the-email-body path. Start time is always 3 days out at 15:00
// IST, so the event is never in the past. console.log is intentional — stdout
// maintenance CLI (C5).
// CLI: node src/scripts/verify-calendar-invite-email.js someone@example.com

import { DateTime } from 'luxon';
import { sendTransactionalEmail } from '../services/email/send-email-service.js';
import { CALENDAR_INVITE_CONTENT_TYPE } from '../services/email/email-constants.js';
import {
  CALENDAR_INVITE_FILENAME, DEFAULT_INTERVIEW_TIMEZONE, INTERVIEW_MODES,
} from '../services/email/calendar-invite-constants.js';
import { buildInterviewInviteIcs } from '../services/email/build-interview-invite-ics.js';
import { EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME } from '../env.js';

const MEETING_URL = 'https://meet.jobmesh.in/room/verify-abc123';

function startThreeDaysFromNowAtThreePmIst() {
  return DateTime.now()
    .setZone(DEFAULT_INTERVIEW_TIMEZONE)
    .plus({ days: 3 })
    .set({ hour: 15, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

async function main() {
  const recipientAddress = process.argv[2];
  if (!recipientAddress || !recipientAddress.includes('@')) {
    console.log('[verify-invite] Usage: node src/scripts/verify-calendar-invite-email.js someone@example.com');
    process.exitCode = 1;
    return;
  }

  const calendarInvite = buildInterviewInviteIcs({
    calendarUid: 'jobmesh-verify-calendar-invite-001@jobmesh.in',
    calendarSequence: 0,
    startAtUtc: startThreeDaysFromNowAtThreePmIst(),
    durationMinutes: 30,
    timezoneId: DEFAULT_INTERVIEW_TIMEZONE,
    mode: INTERVIEW_MODES.IN_PERSON,
    meetingUrl: null,
    // Comma proves LOCATION escaping end-to-end.
    locationText: 'JobMesh HQ, Koramangala, Bengaluru',
    postingTitle: 'Backend Engineer (rendering test)',
    companyName: 'JobMesh',
    candidateName: 'Rendering Test Candidate',
    candidateEmail: recipientAddress,
    organizerName: EMAIL_FROM_NAME,
    organizerEmail: EMAIL_FROM_ADDRESS,
    interviewerEmails: [],
    // Outlook hides the email body when an invite is attached — everything the
    // recipient needs must be in these lines.
    descriptionLines: [
      `Join the call: ${MEETING_URL}`,
      `Need to reschedule? Reply to ${EMAIL_FROM_ADDRESS}.`,
    ],
  });

  const result = await sendTransactionalEmail({
    to: recipientAddress,
    subject: 'JobMesh calendar invite rendering test',
    html: '<p>If you can read this, your mail client shows the body alongside the invite.</p>',
    text: 'If you can read this, your mail client shows the body alongside the invite.',
    attachments: [{
      filename: CALENDAR_INVITE_FILENAME,
      content: Buffer.from(calendarInvite).toString('base64'),
      contentType: CALENDAR_INVITE_CONTENT_TYPE,
    }],
  });

  if (!result.sent) {
    console.log(`[verify-invite] Send failed: ${result.code}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[verify-invite] Sent. emailId=${result.emailId}`);
  console.log('[verify-invite] Now check Gmail, Outlook and Apple Mail rendering.');
}

main().catch((err) => { console.log(`[verify-invite] Fatal: ${err.message}`); process.exitCode = 1; });
