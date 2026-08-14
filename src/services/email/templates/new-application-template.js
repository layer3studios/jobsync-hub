// FILE: src/services/email/templates/new-application-template.js
// "Priya Raman applied to Backend Engineer." Sent to the team, not the candidate.
//
// Deliberately thin — a name, a role, a link. No resume text, no AI score, no cover
// note: this email's job is to get someone to open the pipeline, and every extra
// detail is candidate personal data sitting in an inbox for no added benefit.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

export function buildNewApplicationEmail({
  candidateName, postingTitle, companyName, applicantUrl,
}) {
  const shellInput = {
    previewText: `${candidateName} applied to ${postingTitle}`,
    headingText: 'New application',
    bodyBlocks: [
      `${candidateName} applied to ${postingTitle} at ${companyName}.`,
    ],
    buttonLabel: 'Review the application',
    buttonUrl: applicantUrl,
    footerLines: ['You can turn these off under Settings → Personal on JobMesh.'],
  };
  return {
    subject: `${candidateName} applied to ${postingTitle}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
