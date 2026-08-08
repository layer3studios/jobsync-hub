// FILE: src/services/email/rejection-template-helpers.js
// Renders a company's CUSTOM rejection body into the shared email shell.
//
// Substitution is a plain string replace, not a template engine: the input is a
// short body an employer typed into a settings textarea, and a real engine would
// add an expression evaluator to a string that ends up in an email — far more
// surface than this needs.
//
// An unknown or unfilled placeholder becomes an EMPTY STRING, never the literal
// "{undefined}". A candidate reading a rejection email should never see our
// plumbing leak.

import { renderEmailShell, renderPlainText } from './templates/email-layout-helpers.js';

/** The placeholders an employer may use. Anything else is stripped. */
const PLACEHOLDER_PATTERN = /\{(firstName|jobTitle|companyName)\}/g;

/** "Priya Sharma" → "Priya". Falls back to the whole string when there is no space. */
export function firstNameFrom(fullName) {
  const trimmed = String(fullName ?? '').trim();
  if (trimmed === '') return '';
  return trimmed.split(/\s+/)[0];
}

/**
 * Replace the supported placeholders. Values that are null/undefined resolve to
 * '' so a missing job title leaves a gap rather than a broken token.
 */
export function substituteVariables(body, values) {
  return String(body ?? '').replace(
    PLACEHOLDER_PATTERN,
    (_match, key) => String(values[key] ?? ''),
  );
}

/**
 * Build a full email from a custom body. Blank lines separate paragraphs, which is
 * how the textarea presents it, so what an employer types is what a candidate sees.
 *
 * The SUBJECT is deliberately not customisable: it is the one part of the email a
 * candidate sees before opening, and the defaults are already neutral and accurate.
 * Callers pass the same subject the default template would have used.
 */
export function buildCustomRejectionEmail({ body, subject, headingText, merge }) {
  const values = {
    firstName: firstNameFrom(merge.candidateName),
    jobTitle: merge.jobTitle ?? '',
    companyName: merge.companyName ?? '',
  };
  const rendered = substituteVariables(body, values);
  const bodyBlocks = rendered
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '');

  const shellInput = {
    previewText: subject,
    headingText,
    bodyBlocks,
    footerLines: [`Sent by JobMesh on behalf of ${values.companyName}.`],
  };
  return {
    subject,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

/**
 * Pick the custom body for a stage, or null when the company has not set one.
 * A blank string counts as unset — the validator drops those, but a legacy row
 * could still hold one and it must not send an empty email.
 */
export function customBodyFor(company, stageKey) {
  const body = company?.rejectionEmailTemplates?.[stageKey];
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed;
}
