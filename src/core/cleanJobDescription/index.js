// FILE: src/core/cleanJobDescription/index.js
// Cleans + restructures raw ATS HTML job descriptions:
//   1. Strip noise (scripts, inline styles, empty tags)
//   2. Detect section headings, classify them
//   3. Move boilerplate/company-info to a collapsible secondary block
//
// May return HTML containing:
//   <div class="jd-boilerplate-sections jd-secondary-sections" data-collapsed="true">…</div>
// which the frontend renders as a collapsible block.

import { JSDOM } from 'jsdom';
import { classify } from './patterns.js';
import { isHeadingNode, nodeToHtml, isLikelyCompanyIntroNode, normalizeOutput } from './dom.js';

function decodeEntitiesIfNeeded(rawHtml) {
  // Some ATS APIs return descriptions where <, >, " are HTML-entity-encoded.
  // JSDOM needs real HTML, so unescape these via a textarea round-trip.
  if (!rawHtml.includes('&lt;') && !rawHtml.includes('&gt;')) return rawHtml;
  const decoder = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const ta = decoder.window.document.createElement('textarea');
  ta.innerHTML = rawHtml;
  return ta.value;
}

function stripNoise(root) {
  root.querySelectorAll('script, style, iframe, img, noscript, video, audio').forEach(el => el.remove());
  root.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
  let changed = true;
  while (changed) {
    changed = false;
    root.querySelectorAll('p, div, span, li, h1, h2, h3, h4, h5, h6').forEach(el => {
      const text = (el.textContent || '').replace(/\u00a0/g, '').trim();
      if (!text && el.children.length === 0) {
        el.remove();
        changed = true;
      }
    });
  }
}

function pickWalkRoot(root) {
  const direct = [...root.children];
  if (
    direct.length === 1
    && direct[0].tagName.toLowerCase() === 'div'
    && !direct[0].id
    && !direct[0].className
  ) {
    return direct[0];
  }
  return root;
}

function splitIntoSections(walkRoot) {
  const sections = [];
  let curHeading = null;
  let curHeadingText = '';
  let curNodes = [];

  const flush = () => {
    if (curHeading !== null || curNodes.length > 0) {
      sections.push({
        heading: curHeading,
        headingText: curHeadingText,
        nodes: curNodes,
        category: classify(curHeadingText),
      });
    }
  };

  for (const [idx, node] of [...walkRoot.childNodes].entries()) {
    if (node.nodeType === 3 && !(node.textContent || '').trim()) continue;

    if (isHeadingNode(node)) {
      flush();
      curHeading = node;
      curHeadingText = (node.textContent || '').replace(/\u00a0/g, ' ').trim();
      curNodes = [];
    } else {
      curNodes.push(node);
      if (!curHeading && node.nodeType === 1 && isLikelyCompanyIntroNode(node, idx)) {
        sections.push({
          heading: null,
          headingText: '__auto_company_intro__',
          nodes: [...curNodes],
          category: 'COMPANY_INFO',
        });
        curHeading = null;
        curHeadingText = '';
        curNodes = [];
      }
    }
  }
  flush();
  return sections;
}

function reassemble(sections) {
  const sectionToHtml = (s) => {
    let h = s.heading ? nodeToHtml(s.heading) : '';
    for (const n of s.nodes) h += nodeToHtml(n);
    return h;
  };

  const secondary = sections.filter(s => s.category === 'COMPANY_INFO' || s.category === 'BOILERPLATE');
  const primary = sections.filter(s => s.category === 'ROLE_CONTENT' || s.category === 'UNKNOWN');

  let out = primary.map(sectionToHtml).join('');
  const secHtml = secondary.map(sectionToHtml).join('');
  if (secHtml.trim()) {
    out += `<div class="jd-boilerplate-sections jd-secondary-sections" data-collapsed="true">${secHtml}</div>`;
  }
  return out;
}

/**
 * Clean and restructure a raw ATS HTML job description.
 * @param {string} rawHtml
 * @returns {string} cleaned HTML
 */
export function cleanJobDescription(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';

  try {
    const decoded = decodeEntitiesIfNeeded(rawHtml);
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div id="jd-root">${decoded}</div></body></html>`,
    );
    const root = dom.window.document.getElementById('jd-root');
    stripNoise(root);
    const walkRoot = pickWalkRoot(root);

    const hasHeadings = walkRoot.querySelector('h1, h2, h3, h4, h5, h6') !== null;
    const hasBoldHeadings = [...walkRoot.querySelectorAll('p, div')].some(isHeadingNode);
    if (!hasHeadings && !hasBoldHeadings) {
      return normalizeOutput(root.innerHTML);
    }

    const sections = splitIntoSections(walkRoot);
    const hasSecondary = sections.some(s => s.category === 'COMPANY_INFO' || s.category === 'BOILERPLATE');
    if (!hasSecondary) {
      return normalizeOutput(walkRoot.innerHTML);
    }
    return normalizeOutput(reassemble(sections));
  } catch (err) {
    console.error('[cleanJobDescription]', err.message);
    return rawHtml;
  }
}
