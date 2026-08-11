// FILE: src/services/employer/csv-import-parser.js
// Parses the candidate-import CSV. Written by hand rather than pulled from a
// library because the awkward parts here are the ones libraries disagree about:
// a UTF-8 BOM from Excel, CRLF line endings from Windows, and quoted fields that
// contain the delimiter or a newline.

const REQUIRED_COLUMNS = ['firstname', 'lastname', 'email'];
const MAX_ROWS = 500;

/** Header aliases → our canonical column keys. */
const COLUMN_ALIASES = {
  firstname: 'firstName', 'first name': 'firstName',
  lastname: 'lastName', 'last name': 'lastName',
  email: 'email', 'email address': 'email',
  phone: 'phone', 'phone number': 'phone', mobile: 'phone',
  source: 'source', tags: 'tags',
  resumefilename: 'resumeFilename', 'resume filename': 'resumeFilename', resume: 'resumeFilename',
};

/** Strip the BOM Excel writes and normalize line endings. */
function normalizeText(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

/** Split CSV text into rows of fields, honouring quotes (RFC 4180). */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char !== '"') { field += char; continue; }
      if (text[index + 1] === '"') { field += '"'; index += 1; continue; }
      inQuotes = false;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  // Drop trailing blank lines — a file ending in a newline is not a row of nulls.
  return rows.filter((entry) => entry.some((value) => String(value).trim() !== ''));
}

/** Map a header row to canonical keys; unknown headers become null (ignored). */
export function mapHeaders(headerRow) {
  return headerRow.map((header) => COLUMN_ALIASES[String(header).trim().toLowerCase()] ?? null);
}

/** Which required columns the file is missing, as the header text a user typed. */
export function missingRequiredColumns(headerRow) {
  const present = new Set(
    headerRow.map((header) => String(header).trim().toLowerCase()).map((h) => COLUMN_ALIASES[h]).filter(Boolean),
  );
  return REQUIRED_COLUMNS
    .map((key) => COLUMN_ALIASES[key])
    .filter((canonical) => !present.has(canonical));
}

/** Comma-separated tag cell → canonical lowercase names, capped at 10. */
function parseTagCell(value) {
  return [...new Set(
    String(value ?? '').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  )].slice(0, 10);
}

/**
 * Parse the whole file into { rows, errors, headers }. A row that is missing a
 * required field or carries an unusable email is reported, never imported — and
 * never stops the rows around it.
 */
export function parseCandidateCsv(buffer, { isValidEmail }) {
  const raw = parseCsvRows(normalizeText(buffer));
  if (raw.length === 0) return { rows: [], errors: [], headers: [], missing: [] };

  const headerRow = raw[0];
  const missing = missingRequiredColumns(headerRow);
  if (missing.length > 0) return { rows: [], errors: [], headers: headerRow, missing };

  const keys = mapHeaders(headerRow);
  const rows = [];
  const errors = [];

  for (const [index, values] of raw.slice(1, MAX_ROWS + 1).entries()) {
    const record = {};
    keys.forEach((key, column) => {
      if (key) record[key] = String(values[column] ?? '').trim();
    });
    const label = `Row ${index + 2}`;

    if (!record.firstName || !record.lastName || !record.email) {
      errors.push({ filename: label, reason: 'Missing first name, last name or email.' });
      continue;
    }
    if (!isValidEmail(record.email)) {
      errors.push({ filename: label, reason: `"${record.email}" is not a valid email address.` });
      continue;
    }
    rows.push({
      firstName: record.firstName,
      lastName: record.lastName,
      email: record.email.toLowerCase(),
      phone: record.phone || null,
      sourceDetail: record.source || null,
      tags: parseTagCell(record.tags),
      resumeFilename: record.resumeFilename || null,
      filename: label,
    });
  }

  if (raw.length - 1 > MAX_ROWS) {
    errors.push({ filename: 'File', reason: `Only the first ${MAX_ROWS} rows were imported.` });
  }
  return { rows, errors, headers: headerRow, missing: [] };
}

export { MAX_ROWS as CSV_MAX_ROWS };
