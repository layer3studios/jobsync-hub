// FILE: src/services/email/templates/data-export-link-template.js
// The verification link for a candidate's own data-access request (DPDP).
//
// The email states the expiry and the single-use rule in the body, not just in the
// footer, because a link that has quietly stopped working reads as a broken product
// unless the person was told when it would stop.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

export function buildDataExportLinkEmail({ companyName, downloadUrl }) {
  const shellInput = {
    previewText: `Download the data ${companyName} holds about you`,
    headingText: 'Your data download is ready',
    bodyBlocks: [
      `You asked for a copy of the data ${companyName} holds about you on JobMesh.`,
      'Use the link below to download it. The link works once and expires in 24 hours.',
      "If you didn't make this request, you can ignore this email — nothing was shared.",
    ],
    buttonLabel: 'Download my data',
    buttonUrl: downloadUrl,
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `Your data download from ${companyName}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
