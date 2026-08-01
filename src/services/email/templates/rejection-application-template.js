// FILE: src/services/email/templates/rejection-application-template.js
// Rejection for candidates archived at the Applied / Shortlisted stage —
// before any interview happened. Generic and brief on purpose: at this stage a
// long personal letter reads as insincere.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

export function buildRejectionApplicationEmail({ candidateName, jobTitle, companyName }) {
  const shellInput = {
    previewText: `Update on your application for ${jobTitle}`,
    headingText: 'Update on your application',
    bodyBlocks: [
      `Hi ${candidateName},`,
      `Thank you for applying for the ${jobTitle} position at ${companyName}.`,
      'We have reviewed your application carefully and have decided not to move forward at this time.',
      'We will keep your profile on file and reach out if a future opening looks like a better match.',
      'We wish you the very best in your search.',
      `— The ${companyName} team`,
    ],
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `Update on your application for ${jobTitle}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
