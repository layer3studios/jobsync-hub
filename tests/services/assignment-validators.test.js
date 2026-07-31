// FILE: tests/services/assignment-validators.test.js
// Pure unit tests — no DB, no test-db helper. The validators only import HttpError
// and the model's ALLOWED_FILE_TYPES constant, neither of which touches Mongo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAssignmentTitle, validateAssignmentPublicSummary, validateAssignmentDescription,
  validateSubmissionInstructions, validateEstimatedHours, validateAllowedFileTypes,
} from '../../src/services/employer/assignment-validators.js';

/** Assert the call throws an HttpError with status 400 and the expected code. */
function rejects(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, 400, `expected status 400, got ${err.status}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

test('title: 2 and 120 chars pass, 1 and 121 fail', () => {
  assert.equal(validateAssignmentTitle('ab'), 'ab');
  assert.equal(validateAssignmentTitle('x'.repeat(120)).length, 120);
  rejects(() => validateAssignmentTitle('a'), 'INVALID_TITLE');
  rejects(() => validateAssignmentTitle('x'.repeat(121)), 'INVALID_TITLE');
  rejects(() => validateAssignmentTitle(undefined), 'INVALID_TITLE');
  rejects(() => validateAssignmentTitle(42), 'INVALID_TITLE');
});

test('title trims surrounding whitespace before measuring', () => {
  assert.equal(validateAssignmentTitle('  Build a parser  '), 'Build a parser');
  rejects(() => validateAssignmentTitle('       a       '), 'INVALID_TITLE');
});

test('publicSummary: 10 and 300 chars pass, 9 and 301 fail', () => {
  assert.equal(validateAssignmentPublicSummary('x'.repeat(10)).length, 10);
  assert.equal(validateAssignmentPublicSummary('x'.repeat(300)).length, 300);
  rejects(() => validateAssignmentPublicSummary('x'.repeat(9)), 'INVALID_PUBLIC_SUMMARY');
  rejects(() => validateAssignmentPublicSummary('x'.repeat(301)), 'INVALID_PUBLIC_SUMMARY');
  rejects(() => validateAssignmentPublicSummary(null), 'INVALID_PUBLIC_SUMMARY');
});

test('description: 50 and 20000 chars pass, 49 and 20001 fail', () => {
  assert.equal(validateAssignmentDescription('x'.repeat(50)).length, 50);
  assert.equal(validateAssignmentDescription('x'.repeat(20000)).length, 20000);
  rejects(() => validateAssignmentDescription('x'.repeat(49)), 'INVALID_DESCRIPTION');
  rejects(() => validateAssignmentDescription('x'.repeat(20001)), 'INVALID_DESCRIPTION');
  rejects(() => validateAssignmentDescription(undefined), 'INVALID_DESCRIPTION');
});

test('control characters are stripped BEFORE the length check — padding buys nothing', () => {
  // 49 real characters padded to 60 with control chars must still fail the 50 minimum.
  const padded = 'x'.repeat(49) + '\x00'.repeat(11);
  assert.equal(padded.length, 60);
  rejects(() => validateAssignmentDescription(padded), 'INVALID_DESCRIPTION');

  // And the stripping is genuine: 50 real chars + control chars pass and come back clean.
  const clean = validateAssignmentDescription(`${'x'.repeat(50)}\x07\x1F\x7F`);
  assert.equal(clean, 'x'.repeat(50));
  assert.equal(clean.length, 50);
});

test('tab and newline survive stripping — markdown needs them', () => {
  const body = `# Task\n\n\tindented code\n${'x'.repeat(50)}`;
  const cleaned = validateAssignmentDescription(body);
  assert.ok(cleaned.includes('\n'));
  assert.ok(cleaned.includes('\t'));
});

test('a description with <script> in a fenced code block PASSES (markdown, not plain text)', () => {
  const body = [
    '# Frontend take-home',
    '',
    'Reproduce this snippet and explain the bug:',
    '',
    '```html',
    '<script>window.__boot = () => document.title = "hi";</script>',
    '```',
    '',
    'Write up your reasoning in a short README file please.',
  ].join('\n');
  const cleaned = validateAssignmentDescription(body);
  assert.ok(cleaned.includes('<script>'));
  assert.equal(cleaned.includes('window.__boot'), true);
});

test('submissionInstructions: optional, null/empty → "", ≤5000 enforced', () => {
  assert.equal(validateSubmissionInstructions(null), '');
  assert.equal(validateSubmissionInstructions(undefined), '');
  assert.equal(validateSubmissionInstructions(''), '');
  assert.equal(validateSubmissionInstructions('  Email us a link  '), 'Email us a link');
  assert.equal(validateSubmissionInstructions('x'.repeat(5000)).length, 5000);
  rejects(() => validateSubmissionInstructions('x'.repeat(5001)), 'INVALID_INSTRUCTIONS');
  rejects(() => validateSubmissionInstructions(7), 'INVALID_INSTRUCTIONS');
});

test('submissionInstructions strips control chars before measuring', () => {
  assert.equal(validateSubmissionInstructions(`${'x'.repeat(5000)}\x00\x00`).length, 5000);
});

test('estimatedHours: 1 and 8 pass; 0, 9, 2.5, "2" and null throw', () => {
  assert.equal(validateEstimatedHours(1), 1);
  assert.equal(validateEstimatedHours(8), 8);
  for (const bad of [0, 9, 2.5, '2', null, undefined, NaN]) {
    rejects(() => validateEstimatedHours(bad), 'INVALID_ESTIMATED_HOURS');
  }
});

test('allowedFileTypes: [] ok, undefined → [], duplicates deduped, unknown throws', () => {
  assert.deepEqual(validateAllowedFileTypes([]), []);
  assert.deepEqual(validateAllowedFileTypes(undefined), []);
  assert.deepEqual(validateAllowedFileTypes(null), []);
  assert.deepEqual(validateAllowedFileTypes(['pdf', 'pdf']), ['pdf']);
  assert.deepEqual(validateAllowedFileTypes(['pdf', 'zip', 'md']), ['pdf', 'zip', 'md']);
  rejects(() => validateAllowedFileTypes(['exe']), 'INVALID_FILE_TYPES');
  rejects(() => validateAllowedFileTypes(['pdf', 'exe']), 'INVALID_FILE_TYPES');
  rejects(() => validateAllowedFileTypes('pdf'), 'INVALID_FILE_TYPES');
});
