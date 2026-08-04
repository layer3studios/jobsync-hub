// FILE: tests/services/assignment-submission-validators.test.js
// Pure unit tests — no DB, no filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSubmissionLinks, validateGithubProfileUrl, validateLinkedinProfileUrl,
  validateSeekerNotes,
} from '../../src/services/public/assignment-submission-validators.js';

function rejects(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, 400, `expected status 400, got ${err.status}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

// ── Links ────────────────────────────────────────────────────────────────────
test('links: https accepted, every other scheme rejected', () => {
  const now = new Date();
  assert.deepEqual(
    validateSubmissionLinks(['https://github.com/me/solution'], now),
    [{ url: 'https://github.com/me/solution', addedAt: now }],
  );
  for (const bad of [
    'http://example.com/repo',
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'ftp://files.example.com/x',
    'file:///etc/passwd',
    'not a url at all',
    '//example.com/protocol-relative',
  ]) {
    rejects(() => validateSubmissionLinks([bad], now), 'INVALID_LINK');
  }
});

test('links: absent → [], non-array → INVALID_LINK', () => {
  assert.deepEqual(validateSubmissionLinks(undefined), []);
  assert.deepEqual(validateSubmissionLinks(null), []);
  assert.deepEqual(validateSubmissionLinks(''), []);
  assert.deepEqual(validateSubmissionLinks([]), []);
  rejects(() => validateSubmissionLinks({ url: 'https://x.com' }), 'INVALID_LINK');
});

test('links: exactly 5 accepted, 6 → TOO_MANY_LINKS', () => {
  const five = [1, 2, 3, 4, 5].map((n) => `https://example.com/${n}`);
  assert.equal(validateSubmissionLinks(five).length, 5);
  rejects(() => validateSubmissionLinks([...five, 'https://example.com/6']), 'TOO_MANY_LINKS');
});

test('links: duplicates deduped, original order preserved', () => {
  const result = validateSubmissionLinks([
    'https://example.com/b', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c',
  ]);
  assert.deepEqual(result.map((link) => link.url), [
    'https://example.com/b', 'https://example.com/a', 'https://example.com/c',
  ]);
});

test('links: addedAt comes from the injected now, so a retry cannot drift', () => {
  const now = new Date('2026-03-04T05:06:07.000Z');
  const [link] = validateSubmissionLinks(['https://example.com/x'], now);
  assert.equal(link.addedAt.getTime(), now.getTime());
  // Two calls with the same `now` produce byte-identical output.
  assert.deepEqual(validateSubmissionLinks(['https://example.com/x'], now), [link]);
});

test('links: an over-long URL is rejected', () => {
  rejects(() => validateSubmissionLinks([`https://example.com/${'a'.repeat(2100)}`]), 'INVALID_LINK');
});

// ── GitHub ───────────────────────────────────────────────────────────────────
test('github: a profile URL is accepted', () => {
  assert.equal(validateGithubProfileUrl('https://github.com/octocat'), 'https://github.com/octocat');
  assert.equal(validateGithubProfileUrl('  https://github.com/octocat  '), 'https://github.com/octocat');
  assert.equal(validateGithubProfileUrl('https://www.github.com/octocat'), 'https://www.github.com/octocat');
});

test('github: a REPO url (user/repo) is ACCEPTED, not rejected', () => {
  // Nudging toward the profile URL is the form's job (Chunk 6). Hard-rejecting a
  // working link in an OPTIONAL field over a formatting opinion is hostile.
  const repo = 'https://github.com/octocat/hello-world';
  assert.equal(validateGithubProfileUrl(repo), repo);
  assert.equal(
    validateGithubProfileUrl('https://github.com/octocat/hello-world/tree/main/src'),
    'https://github.com/octocat/hello-world/tree/main/src',
  );
});

test('github: empty → null; other hosts and schemes rejected', () => {
  assert.equal(validateGithubProfileUrl(''), null);
  assert.equal(validateGithubProfileUrl(null), null);
  assert.equal(validateGithubProfileUrl(undefined), null);
  assert.equal(validateGithubProfileUrl('   '), null);

  for (const bad of [
    'https://gitlab.com/octocat',
    'https://github.com.evil.com/octocat',
    'https://notgithub.com/octocat',
    'http://github.com/octocat',
    'https://github.com',
    'https://github.com/',
    `https://github.com/${'a'.repeat(300)}`,
  ]) {
    rejects(() => validateGithubProfileUrl(bad), 'INVALID_GITHUB_URL');
  }
});

// ── LinkedIn ─────────────────────────────────────────────────────────────────
test('linkedin: REGIONAL SUBDOMAINS are accepted — the Indian-candidate regression', () => {
  // in.linkedin.com is what LinkedIn serves Indian users; anchoring on 'www.' would
  // reject a large share of our actual applicant base on their own valid profile.
  for (const url of [
    'https://in.linkedin.com/in/priya-sharma',
    'https://uk.linkedin.com/in/john-smith',
    'https://www.linkedin.com/in/octocat',
    'https://linkedin.com/in/octocat',
    'https://sg.linkedin.com/in/wei-lin',
    'https://www.linkedin.com/in/priya-sharma-1234b5678/',
  ]) {
    assert.equal(validateLinkedinProfileUrl(url), url, `${url} must be accepted`);
  }
});

test('linkedin: the lnkd.in shortener is rejected', () => {
  rejects(() => validateLinkedinProfileUrl('https://lnkd.in/abc123'), 'INVALID_LINKEDIN_URL');
  rejects(() => validateLinkedinProfileUrl('https://www.lnkd.in/abc123'), 'INVALID_LINKEDIN_URL');
});

test('linkedin: non-profile paths are rejected', () => {
  for (const bad of [
    'https://www.linkedin.com/company/acme',
    'https://www.linkedin.com/school/iit-bombay',
    'https://www.linkedin.com/posts/someone-activity-123',
    'https://www.linkedin.com/jobs/view/12345',
    'https://www.linkedin.com/feed',
    'https://www.linkedin.com/',
  ]) {
    rejects(() => validateLinkedinProfileUrl(bad), 'INVALID_LINKEDIN_URL');
  }
});

test('linkedin: empty → null; lookalike hosts and schemes rejected', () => {
  assert.equal(validateLinkedinProfileUrl(''), null);
  assert.equal(validateLinkedinProfileUrl(null), null);
  assert.equal(validateLinkedinProfileUrl(undefined), null);

  for (const bad of [
    'https://linkedin.com.evil.com/in/octocat',
    'https://notlinkedin.com/in/octocat',
    'http://www.linkedin.com/in/octocat',
    'javascript:alert(1)',
  ]) {
    rejects(() => validateLinkedinProfileUrl(bad), 'INVALID_LINKEDIN_URL');
  }
});

// ── Notes ────────────────────────────────────────────────────────────────────
test('notes: absent → empty string; trimmed otherwise', () => {
  assert.equal(validateSeekerNotes(undefined), '');
  assert.equal(validateSeekerNotes(null), '');
  assert.equal(validateSeekerNotes(''), '');
  assert.equal(validateSeekerNotes('  my notes  '), 'my notes');
});

test('notes: <script> inside a fenced code block is ACCEPTED', () => {
  const body = [
    'I found the bug here:', '', '```html',
    '<script>document.cookie</script>', '```', '',
    'The fix was to escape the payload.',
  ].join('\n');
  const result = validateSeekerNotes(body);
  assert.ok(result.includes('<script>'));
  assert.ok(result.includes('</script>'));
});

test('notes: control characters stripped BEFORE the length check', () => {
  // 5000 real chars plus control padding must PASS (the padding is removed first).
  const padded = `${'x'.repeat(5000)}${'\x00'.repeat(50)}`;
  assert.equal(validateSeekerNotes(padded).length, 5000);
  // 5001 real chars must fail.
  rejects(() => validateSeekerNotes('x'.repeat(5001)), 'INVALID_NOTES');
  // Tab and newline survive — markdown needs them.
  const markdown = validateSeekerNotes('# Title\n\n\tindented\n');
  assert.ok(markdown.includes('\n'));
  assert.ok(markdown.includes('\t'));
});

test('notes: a non-string is rejected', () => {
  rejects(() => validateSeekerNotes(42), 'INVALID_NOTES');
  rejects(() => validateSeekerNotes({ text: 'x' }), 'INVALID_NOTES');
});
