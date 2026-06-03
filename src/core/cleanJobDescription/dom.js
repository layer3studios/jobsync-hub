// FILE: src/core/cleanJobDescription/dom.js
// DOM-walking helpers used by the cleaner.

import { HEADING_TAGS, INTRO_CLASS_HINTS, COMPANY_INTRO_CONTENT_PATTERNS } from './patterns.js';

/**
 * Heading detector. Matches real <h1>-<h6> and pseudo-headings such as
 * <p><strong>...</strong></p> common in Lever / Greenhouse output.
 */
export function isHeadingNode(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName.toLowerCase();
  if (HEADING_TAGS.has(tag)) return true;
  if (tag !== 'p' && tag !== 'div') return false;

  const text = (node.textContent || '').trim();
  if (text.length < 2 || text.length > 100) return false;
  const meaningful = [...node.childNodes].filter(
    n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()),
  );
  if (meaningful.length !== 1) return false;
  const kid = meaningful[0];
  return kid.nodeType === 1
    && (kid.tagName.toLowerCase() === 'strong' || kid.tagName.toLowerCase() === 'b');
}

/** Serialize a DOM node back to HTML. */
export function nodeToHtml(node) {
  if (node.nodeType === 1) return node.outerHTML || '';
  if (node.nodeType === 3) {
    const text = node.textContent || '';
    return text.trim() ? text : '';
  }
  return '';
}

/** Heuristic: looks like the first paragraph(s) of a "company intro" block. */
export function isLikelyCompanyIntroNode(node, position = 0) {
  if (!node || node.nodeType !== 1) return false;
  if (position > 2) return false;

  const classNames = (node.className || '').toLowerCase();
  const idName = (node.id || '').toLowerCase();
  if (INTRO_CLASS_HINTS.some(h => classNames.includes(h) || idName.includes(h))) return true;

  const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 80) return false;
  return COMPANY_INTRO_CONTENT_PATTERNS.some(p => p.test(text));
}

/** Final HTML normalization pass. */
export function normalizeOutput(html) {
  return html
    .replace(/\u00a0/g, ' ')
    .replace(/(<br\s*\/?>\s*){2,}/gi, '<br>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*(?:\band\s+)?\b(?:few\s+desction\s+are\s+still\s+not\s+cleaned|few\s+description\s+are\s+still\s+not\s+cleaned)\b\.?\s*/gi, ' ')
    .trim();
}
