// FILE: src/services/email/templates/rejection-position-filled-template.js
// Bulk rejection sent when a position is filled — every remaining non-terminal
// candidate gets the same honest close-out.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

export function buildRejectionPositionFilledEmail({ candidateName, jobTitle, companyName }) {
  const shellInput = {
    previewText: `Update on the ${jobTitle} position`,
    headingText: 'Position update',
    bodyBlocks: [
      `Hi ${candidateName},`,
      `Thank you for your interest in the ${jobTitle} position at ${companyName}.`,
      'The position has now been filled. We appreciate the time you invested in your application.',
      'We will keep your profile on file for future opportunities that match your experience.',
      'We wish you the very best in your search.',
      `— The ${companyName} team`,
    ],
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `Update on the ${jobTitle} position`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
