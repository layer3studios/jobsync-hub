// FILE: tests/services/scoring-prompt.test.js
// The contact_fields extension to the scoring prompt + its defensive parser.
// Pure: no DB, no Gemma, no network.

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
  assert.match(prompt, /github_url/);
  assert.match(prompt, /portfolio_url/);
  assert.match(prompt, /Do not infer/);
});

test('parseScoreResponse returns contactFields null when the model omits contact_fields', () => {
  const parsed = parseScoreResponse(JSON.stringify(SCORE_ONLY));
  assert.equal(parsed.contactFields, null);
  assert.equal(parsed.score, 82); // existing fields untouched
  assert.deepEqual(parsed.matchedSkills, ['React']);
  assert.equal(parsed.explanation, 'Solid match.');
});

test('parseScoreResponse returns contactFields null when the block is not an object', () => {
  assert.equal(parseScoreResponse(withContact('a string')).contactFields, null);
  assert.equal(parseScoreResponse(withContact(['array'])).contactFields, null);
  assert.equal(parseScoreResponse(withContact(null)).contactFields, null);
  assert.equal(parseScoreResponse(withContact(42)).contactFields, null);
});

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

test('parseScoreResponse nulls URLs failing scheme validation', () => {
  const { contactFields } = parseScoreResponse(withContact({
    linkedin_url: 'linkedin.com/in/asha',        // missing scheme
    github_url: 'javascript:alert(1)',           // dangerous scheme
    portfolio_url: 'just some text, not a url',  // not a URL
    location: null,
  }));
  assert.deepEqual(contactFields, {
    linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null,
  });
});

test('parseScoreResponse nulls a linkedin_url not on linkedin.com', () => {
  const { contactFields } = parseScoreResponse(withContact({ linkedin_url: 'https://example.com/in/asha' }));
  assert.equal(contactFields.linkedinUrl, null);
});

test('parseScoreResponse nulls a github_url not on github.com', () => {
  const { contactFields } = parseScoreResponse(withContact({ github_url: 'https://gitlab.com/asharao' }));
  assert.equal(contactFields.githubUrl, null);
});

test('parseScoreResponse accepts any valid http/https URL for portfolio_url', () => {
  assert.equal(
    parseScoreResponse(withContact({ portfolio_url: 'https://example.com/portfolio' })).contactFields.portfolioUrl,
    'https://example.com/portfolio',
  );
  assert.equal(
    parseScoreResponse(withContact({ portfolio_url: 'http://asha.dev' })).contactFields.portfolioUrl,
    'http://asha.dev',
  );
});

test('parseScoreResponse truncates a >200-char location to exactly 200', () => {
  const { contactFields } = parseScoreResponse(withContact({ location: 'x'.repeat(250) }));
  assert.equal(contactFields.location.length, 200);
});

test('parseScoreResponse returns null for a whitespace-only or empty location', () => {
  assert.equal(parseScoreResponse(withContact({ location: '   ' })).contactFields.location, null);
  assert.equal(parseScoreResponse(withContact({ location: '' })).contactFields.location, null);
});

test('parseScoreResponse nulls empty-string and non-string contact values', () => {
  const { contactFields } = parseScoreResponse(withContact({
    linkedin_url: '', github_url: '   ', portfolio_url: 12345, location: null,
  }));
  assert.deepEqual(contactFields, {
    linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null,
  });
});

test('validateExtractedUrl enforces scheme, parseability and host', () => {
  assert.equal(validateExtractedUrl('https://linkedin.com/in/a', 'linkedin.com'), 'https://linkedin.com/in/a');
  assert.equal(validateExtractedUrl('http://in.linkedin.com/in/a', 'linkedin.com'), 'http://in.linkedin.com/in/a');
  assert.equal(validateExtractedUrl('https://evil.com/in/a', 'linkedin.com'), null);
  assert.equal(validateExtractedUrl('javascript:alert(1)'), null);
  assert.equal(validateExtractedUrl('https://'), null);
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
