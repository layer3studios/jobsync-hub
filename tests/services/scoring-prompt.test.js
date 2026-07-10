// FILE: tests/services/scoring-prompt.test.js
// Covers the contact_fields extension to the scoring prompt/parser (T1.1 D9 h-l).
// No DB, no Gemma — parseScoreResponse and its validators are pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScoringSystemPrompt, parseScoreResponse,
  validateExtractedUrl, validateExtractedLocation,
} from '../../src/services/public/scoring-prompt.js';

const SCORE_ONLY = {
  score: 82, matched_skills: ['React'], missing_skills: [], bonus_skills: [],
  experience_fit: 'good', location_fit: 'exact', notice_period_fit: 'within_30',
  explanation: 'Solid match.',
};

const withContact = (contactFields) => JSON.stringify({ ...SCORE_ONLY, contact_fields: contactFields });

test('the prompt asks for contact_fields and forbids inference', () => {
  const prompt = buildScoringSystemPrompt({ required_skills: ['React'] }, 'resume text');
  assert.match(prompt, /"contact_fields"/);
  assert.match(prompt, /linkedin_url/);
  assert.match(prompt, /Do not infer/);
});

// D9(h) — backward compatibility with pre-change Gemma responses.
test('parseScoreResponse returns contactFields: null when contact_fields is absent', () => {
  const parsed = parseScoreResponse(JSON.stringify(SCORE_ONLY));
  assert.equal(parsed.contactFields, null);
  assert.equal(parsed.score, 82); // existing fields untouched
  assert.deepEqual(parsed.matchedSkills, ['React']);
});

test('parseScoreResponse returns contactFields: null when contact_fields is malformed', () => {
  assert.equal(parseScoreResponse(withContact('a string')).contactFields, null);
  assert.equal(parseScoreResponse(withContact(['array'])).contactFields, null);
  assert.equal(parseScoreResponse(withContact(null)).contactFields, null);
  assert.equal(parseScoreResponse(withContact(42)).contactFields, null);
});

// D9(l)
test('parseScoreResponse maps a fully valid contact_fields block to camelCase', () => {
  const { contactFields } = parseScoreResponse(withContact({
    linkedin_url: 'https://www.linkedin.com/in/asha-rao',
    github_url: 'https://github.com/asharao',
    portfolio_url: 'https://asha.dev/work',
    location: '  Bangalore, India  ',
  }));
  assert.deepEqual(contactFields, {
    linkedinUrl: 'https://www.linkedin.com/in/asha-rao',
    githubUrl: 'https://github.com/asharao',
    portfolioUrl: 'https://asha.dev/work',
    location: 'Bangalore, India',
  });
});

// D9(i) — each failure mode collapses to null, silently.
test('parseScoreResponse nulls URLs that fail validation', () => {
  const { contactFields } = parseScoreResponse(withContact({
    linkedin_url: 'linkedin.com/in/asha',   // missing scheme
    github_url: 'ftp://github.com/asharao', // wrong scheme
    portfolio_url: 'https://',              // unparseable
    location: null,
  }));
  assert.deepEqual(contactFields, {
    linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null,
  });
});

test('parseScoreResponse nulls empty-string and non-string contact values (D8)', () => {
  const { contactFields } = parseScoreResponse(withContact({
    linkedin_url: '', github_url: '   ', portfolio_url: 12345, location: '   ',
  }));
  assert.deepEqual(contactFields, {
    linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null,
  });
});

// D9(j)
test('parseScoreResponse nulls a linkedin_url that is not on linkedin.com', () => {
  const { contactFields } = parseScoreResponse(withContact({
    linkedin_url: 'https://example.com/in/asha',
    github_url: 'https://gitlab.com/asharao',
    portfolio_url: 'https://example.com/portfolio', // no host constraint → kept
  }));
  assert.equal(contactFields.linkedinUrl, null);
  assert.equal(contactFields.githubUrl, null);
  assert.equal(contactFields.portfolioUrl, 'https://example.com/portfolio');
});

// D9(k)
test('parseScoreResponse truncates a >200-char location to exactly 200', () => {
  const { contactFields } = parseScoreResponse(withContact({ location: 'x'.repeat(250) }));
  assert.equal(contactFields.location.length, 200);
});

test('validateExtractedUrl enforces scheme, parseability and host', () => {
  assert.equal(validateExtractedUrl('https://linkedin.com/in/a', 'linkedin.com'), 'https://linkedin.com/in/a');
  assert.equal(validateExtractedUrl('http://in.linkedin.com/in/a', 'linkedin.com'), 'http://in.linkedin.com/in/a');
  assert.equal(validateExtractedUrl('https://evil.com/in/a', 'linkedin.com'), null);
  assert.equal(validateExtractedUrl('javascript:alert(1)'), null);
  assert.equal(validateExtractedUrl(undefined), null);
  assert.equal(validateExtractedUrl('https://any.host/path'), 'https://any.host/path');
});

test('validateExtractedLocation trims, truncates, and nulls blanks', () => {
  assert.equal(validateExtractedLocation('  Pune  '), 'Pune');
  assert.equal(validateExtractedLocation(''), null);
  assert.equal(validateExtractedLocation('\t\n '), null);
  assert.equal(validateExtractedLocation(null), null);
  assert.equal(validateExtractedLocation('y'.repeat(500)).length, 200);
});
