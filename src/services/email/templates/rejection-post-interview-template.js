// FILE: src/services/email/templates/rejection-post-interview-template.js
// Rejection for candidates archived at or after the Interview stage. They gave
// us their time, so this one is warmer and more personal. `standoutSkill` is
// optional — when the caller has nothing specific, the sentence is omitted
// rather than filled with a hollow placeholder.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

export function buildRejectionPostInterviewEmail({ candidateName, jobTitle, companyName, standoutSkill }) {
  const bodyBlocks = [
    `Hi ${candidateName},`,
    `Thank you for taking the time to interview for the ${jobTitle} position at ${companyName}. We enjoyed the conversation and appreciated the chance to learn about your experience.`,
    'After careful consideration, we have decided to move forward with other candidates for this role.',
  ];
  if (standoutSkill) {
    bodyBlocks.push(`Your skills in ${standoutSkill} stood out to us, and we will keep your profile in mind for future openings.`);
  } else {
    bodyBlocks.push('We will keep your profile in mind for future openings.');
  }
  bodyBlocks.push(
    'We wish you every success in your search.',
    `— The ${companyName} team`,
  );

  const shellInput = {
    previewText: `Following up on your interview for ${jobTitle}`,
    headingText: 'Following up on your interview',
    bodyBlocks,
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `Following up on your interview for ${jobTitle}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
