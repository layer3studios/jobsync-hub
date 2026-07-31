// FILE: src/scripts/verify-calendar-invite-email.js
// One-off manual verification of calendar-invite rendering across mail clients
// (Gmail, Outlook, Apple Mail). Builds a minimal RFC 5545 VCALENDAR inline —
// deliberately NOT via ical-generator (that lands in chunk 2) — and sends it as
// an .ics attachment with the exact Content-Type Outlook needs to render it as
// an invitation. console.log is intentional — stdout maintenance CLI (C5).
// CLI: node src/scripts/verify-calendar-invite-email.js someone@example.com

import { sendTransactionalEmail } from '../services/email/send-email-service.js';
import { CALENDAR_INVITE_CONTENT_TYPE } from '../services/email/email-constants.js';
import { EMAIL_FROM_ADDRESS } from '../env.js';

/** UTC timestamp in basic iCalendar form, e.g. 20260731T093000Z. */
function icalendarTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildCalendarInvite(recipientAddress) {
  // CRLF line endings are mandatory per RFC 5545 — bare \n breaks strict parsers.
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JobMesh//Interview Invite Verification//EN',
    'METHOD:REQUEST',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Kolkata',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    // India observes no DST, so a single STANDARD block with identical offsets
    // and no DAYLIGHT sub-component is correct.
    'TZOFFSETFROM:+0530',
    'TZOFFSETTO:+0530',
    'TZNAME:IST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:jobmesh-verify-calendar-invite-001@jobmesh.in',
    'SEQUENCE:0',
    `DTSTAMP:${icalendarTimestamp(new Date())}`,
    'DTSTART;TZID=Asia/Kolkata:20260810T110000',
    'DTEND;TZID=Asia/Kolkata:20260810T113000',
    'SUMMARY:JobMesh interview invite rendering test',
    // The escaped comma (\,) proves LOCATION escaping survives end-to-end.
    'LOCATION:JobMesh HQ\\, Bengaluru',
    `ORGANIZER;CN=JobMesh:mailto:${EMAIL_FROM_ADDRESS}`,
    `ATTENDEE;CN=Candidate;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${recipientAddress}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

async function main() {
  const recipientAddress = process.argv[2];
  if (!recipientAddress || !recipientAddress.includes('@')) {
    console.log('[verify-invite] Usage: node src/scripts/verify-calendar-invite-email.js someone@example.com');
    process.exitCode = 1;
    return;
  }

  const calendarInvite = buildCalendarInvite(recipientAddress);
  const result = await sendTransactionalEmail({
    to: recipientAddress,
    subject: 'JobMesh calendar invite rendering test',
    html: '<p>This email verifies that the attached interview invite renders as a real calendar invitation.</p>',
    text: 'This email verifies that the attached interview invite renders as a real calendar invitation.',
    attachments: [{
      filename: 'interview.ics',
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
