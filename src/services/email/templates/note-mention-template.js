// FILE: src/services/email/templates/note-mention-template.js
// "Priya mentioned you on Alex Kumar's profile."
//
// The note preview is deliberately short and truncated: this email is a pointer,
// not a copy of the note. Notes are internal employer commentary on a candidate, so
// the less of one that sits in an inbox the better — the link is where it belongs.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';

const PREVIEW_CHARACTER_LIMIT = 180;

/** First 180 chars on one line, with an ellipsis only when something was cut. */
export function buildNotePreview(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARACTER_LIMIT
    ? `${flat.slice(0, PREVIEW_CHARACTER_LIMIT).trimEnd()}…`
    : flat;
}

export function buildNoteMentionEmail({
  authorName, candidateName, postingTitle, notePreview, applicantUrl,
}) {
  const shellInput = {
    previewText: `${authorName} mentioned you on ${candidateName}'s profile`,
    headingText: `${authorName} mentioned you`,
    bodyBlocks: [
      `${authorName} mentioned you in a note on ${candidateName}'s application for ${postingTitle}:`,
      `"${notePreview}"`,
    ],
    buttonLabel: 'Open the application',
    buttonUrl: applicantUrl,
    footerLines: ['You received this because a teammate mentioned you in a note on JobMesh.'],
  };
  return {
    subject: `${authorName} mentioned you on ${candidateName}'s profile`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}
