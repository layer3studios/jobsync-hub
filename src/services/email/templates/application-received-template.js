// FILE: src/services/email/templates/application-received-template.js
// Confirmation sent the moment an application lands. Deliberately short: its only
// job is to close the loop so a candidate is not left wondering whether the form
// submitted. Promises nothing about timing beyond "you'll hear from us either way".

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

export function buildApplicationReceivedEmail({ firstName, postingTitle, companyName }) {
  const shellInput = {
    previewText: `We received your application for ${postingTitle}`,
    headingText: 'We received your application',
    bodyBlocks: [
      `Hi ${firstName},`,
      `Thanks for applying to ${postingTitle} at ${companyName}.`,
      "We've received your application and our team will review it shortly. You'll hear from us either way.",
      'Good luck!',
      `— The ${companyName} team`,
    ],
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `We received your application — ${postingTitle} at ${companyName}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
