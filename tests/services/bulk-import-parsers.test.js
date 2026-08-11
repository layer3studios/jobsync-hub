// FILE: tests/services/bulk-import-parsers.test.js
// The pure halves of sprint 3: CSV rendering and parsing, the ZIP reader, resume
// identity guessing, and the auto-archive threshold. No database is touched here —
// every one of these is a function of its input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'zlib';
import { renderCsv, escapeField, csvFilenameFor } from '../../src/services/employer/applicant-csv-service.js';
import { parseCandidateCsv, parseCsvRows } from '../../src/services/employer/csv-import-parser.js';
import { listZipEntries, readZipEntry, isArchiveNoise, ZipError } from '../../src/services/employer/zip-reader.js';
import { parseResumeIdentity, findEmail, findName } from '../../src/services/employer/resume-parse-heuristics.js';
import { resolveStaleDays } from '../../src/tasks/auto-archive-stale.js';
import { isNonCountableView } from '../../src/services/public/posting-view-counter.js';

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());

// ── CSV export ──────────────────────────────────────────────────────────────

test('escapeField quotes everything and doubles internal quotes', () => {
  assert.equal(escapeField('O\'Brien, Bob'), '"O\'Brien, Bob"');
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeField(null), '""');
  assert.equal(escapeField(undefined), '""');
  assert.equal(escapeField(0), '"0"');
});

test('renderCsv writes a header plus CRLF-delimited rows', () => {
  const csv = renderCsv([['Ada, Lovelace', '', 87]]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('"First Name","Last Name"'));
  assert.ok(lines[1].startsWith('"Ada, Lovelace","","87"'));
});

test('csvFilenameFor uses the posting slug and the date', () => {
  const name = csvFilenameFor({ slug: 'senior-engineer' }, new Date('2026-08-11T10:00:00Z'));
  assert.equal(name, 'senior-engineer-applicants-2026-08-11.csv');
  assert.match(csvFilenameFor({}, new Date('2026-08-11T10:00:00Z')), /^posting-applicants-/);
});

// ── CSV import ──────────────────────────────────────────────────────────────

test('parseCsvRows honours quotes, embedded commas and newlines', () => {
  const rows = parseCsvRows('a,"b,c"\n"line\nbreak",d\n');
  assert.deepEqual(rows, [['a', 'b,c'], ['line\nbreak', 'd']]);
});

test('parseCandidateCsv strips a BOM, accepts CRLF, and reports bad rows', () => {
  const text = '﻿firstName,lastName,email,phone,tags\r\n'
    + 'Ada,"Lovelace, Jr",ADA@example.com,123,"referral, strong"\r\n'
    + 'Missing,,nobody@example.com\r\n'
    + 'Bad,Email,not-an-email\r\n';
  const { rows, errors, missing } = parseCandidateCsv(Buffer.from(text, 'utf8'), { isValidEmail });

  assert.deepEqual(missing, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'ada@example.com');
  assert.equal(rows[0].lastName, 'Lovelace, Jr');
  assert.deepEqual(rows[0].tags, ['referral', 'strong']);
  assert.equal(errors.length, 2);
  assert.match(errors[0].reason, /Missing first name/);
  assert.match(errors[1].reason, /not a valid email/);
});

test('parseCandidateCsv names the required columns a file is missing', () => {
  const { missing, rows } = parseCandidateCsv(Buffer.from('name,email\nAda,a@b.co\n'), { isValidEmail });
  assert.deepEqual(missing, ['firstName', 'lastName']);
  assert.deepEqual(rows, []);
});

// ── ZIP reading ─────────────────────────────────────────────────────────────

/** Build a minimal single-entry ZIP (deflate) so the reader is tested end to end. */
function buildZip(name, contents) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const data = Buffer.from(contents, 'utf8');
  const deflated = zlib.deflateRawSync(data);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;

  const local = Buffer.alloc(30 + nameBuffer.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);            // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  nameBuffer.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuffer.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);         // local header offset
  nameBuffer.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + deflated.length, 16);

  return Buffer.concat([local, deflated, central, eocd]);
}

test('listZipEntries + readZipEntry round-trip a deflated entry', () => {
  const zip = buildZip('alice.pdf', '%PDF-1.4 hello');
  const entries = listZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'alice.pdf');
  assert.equal(readZipEntry(zip, entries[0]).toString('utf8'), '%PDF-1.4 hello');
});

test('a non-ZIP buffer is refused with a readable message', () => {
  assert.throws(() => listZipEntries(Buffer.from('not a zip at all, really')), ZipError);
  assert.throws(() => listZipEntries(Buffer.alloc(4)), ZipError);
});

test('archiver and OS noise is recognised so it never becomes a candidate', () => {
  assert.equal(isArchiveNoise('__MACOSX/alice.pdf'), true);
  assert.equal(isArchiveNoise('resumes/._alice.pdf'), true);
  assert.equal(isArchiveNoise('.DS_Store'), true);
  assert.equal(isArchiveNoise('resumes/alice.pdf'), false);
});

// ── Resume identity ─────────────────────────────────────────────────────────

test('findEmail and findName read the top of a resume', () => {
  const text = 'Ada Lovelace\nSoftware Engineer\nada.love@example.com | +91 99999 11111\n';
  assert.equal(findEmail(text), 'ada.love@example.com');
  assert.equal(findName(text), 'Ada Lovelace');
});

test('a resume with no email gets an unroutable placeholder from its filename', () => {
  const identity = parseResumeIdentity('', 'Ada Lovelace CV.pdf');
  assert.equal(identity.email, 'ada-lovelace-cv@imported.local');
  assert.equal(identity.emailWasGuessed, true);
});

// ── Auto-archive + view counting ────────────────────────────────────────────

test('resolveStaleDays accepts 7–90 and treats everything else as off', () => {
  assert.equal(resolveStaleDays(30), 30);
  assert.equal(resolveStaleDays(7), 7);
  assert.equal(resolveStaleDays(90), 90);
  assert.equal(resolveStaleDays(6), null);
  assert.equal(resolveStaleDays(91), null);
  assert.equal(resolveStaleDays(null), null);
  assert.equal(resolveStaleDays(undefined), null);
});

test('employer and bot requests never move the view counter', () => {
  const request = (userAgent, cookies = {}) => ({ cookies, get: () => userAgent });
  assert.equal(isNonCountableView(request('Mozilla/5.0 (Macintosh) Safari/605')), false);
  assert.equal(isNonCountableView(request('Googlebot/2.1')), true);
  assert.equal(isNonCountableView(request('curl/8.4.0')), true);
  assert.equal(isNonCountableView(request('')), true);
  assert.equal(isNonCountableView(request('Mozilla/5.0', { jm_employer_token: 'abc' })), true);
});
