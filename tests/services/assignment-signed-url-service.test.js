// FILE: tests/services/assignment-signed-url-service.test.js
// Pure crypto tests — no DB, no filesystem, no test-db helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSIGNMENT_FILE_TTL_MS, signAssignmentFileToken, verifyAssignmentFileToken,
  signStagedFileToken, verifyStagedFileToken,
} from '../../src/services/employer/assignment-signed-url-service.js';

const SECRET = 'test-assignment-secret';
const OTHER_SECRET = 'a-completely-different-secret';
const STORAGE_PATH = 'data/assignment-submissions/2f1c9e6a-1111-2222-3333-444455556666.pdf';

const STAGED = {
  uuid: '2f1c9e6a-1111-2222-3333-444455556666',
  ext: 'pdf',
  originalName: 'my take-home answer.pdf',
  sizeBytes: 204_800,
  mimeType: 'application/pdf',
};

/** Assert an HttpError with the expected status and code. */
function rejects(fn, status, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

// ── Download tokens ──────────────────────────────────────────────────────────
test('sign → verify round-trips the storagePath', () => {
  const token = signAssignmentFileToken(STORAGE_PATH, ASSIGNMENT_FILE_TTL_MS, SECRET);
  assert.equal(verifyAssignmentFileToken(token, SECRET).storagePath, STORAGE_PATH);
});

test('the token is opaque — it does not leak the path in plain text', () => {
  const token = signAssignmentFileToken(STORAGE_PATH, ASSIGNMENT_FILE_TTL_MS, SECRET);
  assert.equal(token.includes(STORAGE_PATH), false);
  assert.equal(token.includes('assignment-submissions'), false);
});

test('a tampered token → 401 INVALID_TOKEN', () => {
  const token = signAssignmentFileToken(STORAGE_PATH, ASSIGNMENT_FILE_TTL_MS, SECRET);
  const flipped = `${token.slice(0, -3)}${token.slice(-3) === 'AAA' ? 'BBB' : 'AAA'}`;
  rejects(() => verifyAssignmentFileToken(flipped, SECRET), 401, 'INVALID_TOKEN');
});

test('a re-signed payload with a DIFFERENT path → 401 (signature covers the path)', () => {
  const forged = signAssignmentFileToken('data/assignment-submissions/other.pdf', ASSIGNMENT_FILE_TTL_MS, OTHER_SECRET);
  rejects(() => verifyAssignmentFileToken(forged, SECRET), 401, 'INVALID_TOKEN');
});

test('the wrong secret → 401 INVALID_TOKEN', () => {
  const token = signAssignmentFileToken(STORAGE_PATH, ASSIGNMENT_FILE_TTL_MS, SECRET);
  rejects(() => verifyAssignmentFileToken(token, OTHER_SECRET), 401, 'INVALID_TOKEN');
});

test('an expired token → 401 INVALID_TOKEN', () => {
  for (const ttl of [0, -1, -60_000]) {
    const token = signAssignmentFileToken(STORAGE_PATH, ttl, SECRET);
    rejects(() => verifyAssignmentFileToken(token, SECRET), 401, 'INVALID_TOKEN');
  }
});

test('garbage input → 401, never an unexpected throw', () => {
  for (const bad of ['', null, undefined, 'abc', '....', '{}', Buffer.from('nope').toString('base64url')]) {
    rejects(() => verifyAssignmentFileToken(bad, SECRET), 401, 'INVALID_TOKEN');
  }
});

test('NO ORACLE: every failure mode returns byte-identical status, code and message', () => {
  const valid = signAssignmentFileToken(STORAGE_PATH, ASSIGNMENT_FILE_TTL_MS, SECRET);
  const failures = [
    () => verifyAssignmentFileToken(`${valid}xx`, SECRET),                              // tampered
    () => verifyAssignmentFileToken(valid, OTHER_SECRET),                               // wrong secret
    () => verifyAssignmentFileToken(signAssignmentFileToken(STORAGE_PATH, -1, SECRET), SECRET), // expired
    () => verifyAssignmentFileToken('abc', SECRET),                                     // malformed
    () => verifyAssignmentFileToken('', SECRET),                                        // empty
  ];
  const seen = failures.map((fn) => {
    try { fn(); return null; } catch (err) { return `${err.status}|${err.code}|${err.message}`; }
  });
  assert.equal(seen.every((entry) => entry !== null), true, 'every case must throw');
  assert.equal(new Set(seen).size, 1, `failure modes must be indistinguishable, saw: ${JSON.stringify(seen)}`);
});

// ── Staged file tokens (the seeker's fileId) ─────────────────────────────────
test('staged token round-trips all five fields', () => {
  const { token } = signStagedFileToken(STAGED, 60_000, SECRET);
  assert.deepEqual(verifyStagedFileToken(token, SECRET), STAGED);
});

test('signStagedFileToken reports the expiry it stamped', () => {
  const before = Date.now();
  const { expiresAt } = signStagedFileToken(STAGED, 60_000, SECRET);
  assert.ok(expiresAt >= before + 60_000);
  assert.ok(expiresAt <= Date.now() + 60_000);
});

test('the staged token does not leak the uuid or filename in plain text', () => {
  const { token } = signStagedFileToken(STAGED, 60_000, SECRET);
  assert.equal(token.includes(STAGED.uuid), false);
  assert.equal(token.includes('take-home'), false);
});

test('an EXPIRED staged token → STAGED_FILE_EXPIRED, not INVALID_FILE_ID', () => {
  const { token } = signStagedFileToken(STAGED, -1, SECRET);
  rejects(() => verifyStagedFileToken(token, SECRET), 400, 'STAGED_FILE_EXPIRED');
});

test('a TAMPERED staged token → INVALID_FILE_ID, not STAGED_FILE_EXPIRED', () => {
  const { token } = signStagedFileToken(STAGED, 60_000, SECRET);
  rejects(() => verifyStagedFileToken(`${token}zz`, SECRET), 400, 'INVALID_FILE_ID');
});

test('the wrong secret on a staged token → INVALID_FILE_ID (never reported as expired)', () => {
  const { token } = signStagedFileToken(STAGED, 60_000, SECRET);
  rejects(() => verifyStagedFileToken(token, OTHER_SECRET), 400, 'INVALID_FILE_ID');
});

test('garbage staged ids → INVALID_FILE_ID', () => {
  for (const bad of ['', null, undefined, 'abc', 'not-a-token']) {
    rejects(() => verifyStagedFileToken(bad, SECRET), 400, 'INVALID_FILE_ID');
  }
});

test('an expired-AND-wrong-secret token is reported as invalid, not expired', () => {
  // Expiry must never be reported for a token we cannot authenticate — otherwise a
  // forger learns their payload parsed correctly.
  const { token } = signStagedFileToken(STAGED, -1, SECRET);
  rejects(() => verifyStagedFileToken(token, OTHER_SECRET), 400, 'INVALID_FILE_ID');
});

test('a download token is not usable as a staged token and vice versa', () => {
  const download = signAssignmentFileToken(STORAGE_PATH, 60_000, SECRET);
  rejects(() => verifyStagedFileToken(download, SECRET), 400, 'INVALID_FILE_ID');
});
