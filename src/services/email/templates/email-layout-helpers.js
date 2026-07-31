// FILE: src/services/email/templates/email-layout-helpers.js
// The single email shell every JobMesh email renders through. Outlook on
// Windows uses the Word rendering engine, so: table-based layout only, all CSS
// inline, system font stack, no images, bulletproof table-cell button. Every
// template must send BOTH html and text — never html-only.

const FONT_STACK = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BUTTON_BACKGROUND_COLOR = '#1a56db';
const TEXT_COLOR = '#1f2937';
const MUTED_TEXT_COLOR = '#6b7280';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function paragraph(block) {
  return `<p style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${TEXT_COLOR};">${escapeHtml(block)}</p>`;
}

/** Bulletproof button: a table cell with background + padding, never an image. */
function buttonTable(buttonLabel, buttonUrl) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr>`
    + `<td bgcolor="${BUTTON_BACKGROUND_COLOR}" style="background-color:${BUTTON_BACKGROUND_COLOR};padding:12px 28px;">`
    + `<a href="${escapeHtml(buttonUrl)}" style="font-family:${FONT_STACK};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;display:inline-block;">${escapeHtml(buttonLabel)}</a>`
    + `</td></tr></table>`;
}

/**
 * Render the shared shell. bodyBlocks and footerLines are arrays of plain-text
 * strings (escaped here). The button renders only when both label and url are
 * given. previewText becomes a hidden preheader span at the very top.
 */
export function renderEmailShell({ previewText, headingText, bodyBlocks, buttonLabel, buttonUrl, footerLines }) {
  const preheader = previewText
    ? `<span style="display:none;font-size:1px;color:#ffffff;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(previewText)}</span>`
    : '';
  const bodyHtml = (bodyBlocks ?? []).map(paragraph).join('');
  const buttonHtml = buttonLabel && buttonUrl ? buttonTable(buttonLabel, buttonUrl) : '';
  const footerHtml = (footerLines ?? [])
    .map((line) => `<p style="margin:0 0 4px 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${MUTED_TEXT_COLOR};">${escapeHtml(line)}</p>`)
    .join('');

  return `${preheader}`
    + `<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6"><tr><td align="center" style="padding:24px 12px;">`
    + `<table width="600" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"><tr><td style="padding:32px;">`
    + `<h1 style="margin:0 0 20px 0;font-family:${FONT_STACK};font-size:20px;line-height:28px;color:${TEXT_COLOR};">${escapeHtml(headingText)}</h1>`
    + bodyHtml
    + buttonHtml
    + footerHtml
    + `</td></tr></table>`
    + `</td></tr></table>`;
}

/** The text/plain equivalent of renderEmailShell — same content, no markup. */
export function renderPlainText({ headingText, bodyBlocks, buttonLabel, buttonUrl, footerLines }) {
  const lines = [headingText, ''];
  for (const block of bodyBlocks ?? []) lines.push(block, '');
  if (buttonLabel && buttonUrl) lines.push(`${buttonLabel}: ${buttonUrl}`, '');
  for (const line of footerLines ?? []) lines.push(line);
  return lines.join('\n').trim() + '\n';
}
