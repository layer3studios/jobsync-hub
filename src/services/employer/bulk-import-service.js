// FILE: src/services/employer/bulk-import-service.js
// The two bulk-import methods: a ZIP of resume PDFs, and a CSV of rows with
// optional resume files. Both converge on candidate-import-service for the actual
// writes, so a candidate created either way is indistinguishable afterwards.
//
// Nothing is extracted to disk. The ZIP is decompressed entry by entry in memory
// and each PDF's bytes go straight to resume-storage-service, so there is no temp
// directory to clean up and no half-extracted archive left behind by a crash.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { extractTextFromPDF } from '../seeker/resume-text-extractor.js';
import { listZipEntries, readZipEntry, basename, isArchiveNoise, ZipError } from './zip-reader.js';
import { parseResumeIdentity } from './resume-parse-heuristics.js';
import { parseCandidateCsv } from './csv-import-parser.js';
import {
  createImportSummary, recordFailure, toPublicSummary, applyRowToSummary,
  requireDefaultStage, isValidEmail, MAX_IMPORT_FILES,
} from './candidate-import-service.js';

const PDF_MAGIC = '%PDF';

/** A PDF by extension AND by magic bytes — an extension alone is a claim, not a fact. */
const looksLikePdf = (name, buffer) => /\.pdf$/i.test(name)
  && buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === PDF_MAGIC;

/**
 * Import every PDF in a ZIP as a candidate on one posting.
 *
 * Non-PDF entries are skipped with a warning; a nested archive is refused outright
 * (flat archives only — recursing invites a zip bomb and confuses the file→candidate
 * mapping a recruiter is reasoning about).
 */
export async function importResumesFromZip(companyId, posting, zipBuffer) {
  let entries;
  try {
    entries = listZipEntries(zipBuffer);
  } catch (err) {
    if (err instanceof ZipError) throw new HttpError(400, err.message, 'INVALID_ZIP');
    throw err;
  }

  const stage = await requireDefaultStage(companyId);
  const summary = createImportSummary();
  const files = entries.filter((entry) => !isArchiveNoise(entry.name));

  if (files.some((entry) => /\.zip$/i.test(entry.name))) {
    throw new HttpError(
      400,
      'This archive contains another ZIP. Upload a flat archive of PDF files.',
      'NESTED_ZIP',
    );
  }
  if (files.length > MAX_IMPORT_FILES) {
    throw new HttpError(
      400,
      `An archive can hold up to ${MAX_IMPORT_FILES} resumes. Split it into smaller uploads.`,
      'TOO_MANY_FILES',
    );
  }

  for (const entry of files) {
    const filename = basename(entry.name);
    let buffer;
    try {
      buffer = readZipEntry(zipBuffer, entry);
    } catch {
      recordFailure(summary, filename, 'Could not read this file from the archive.');
      continue;
    }
    if (!looksLikePdf(filename, buffer)) {
      recordFailure(summary, filename, 'Skipped — only PDF resumes are imported.');
      continue;
    }

    let text;
    try {
      ({ text } = await extractTextFromPDF(buffer));
    } catch {
      // A scanned or corrupt PDF still describes a real person, so the candidate is
      // created from the filename and the resume is attached for a human to read.
      text = '';
    }
    const identity = parseResumeIdentity(text, filename);
    await applyRowToSummary(
      summary, companyId, posting, stage,
      { ...identity, filename, sourceDetail: filename },
      { resume: { buffer, filename } },
    );
  }

  return toPublicSummary(summary);
}

/** Index uploaded resume files by their bare filename, lowercased. */
function indexResumeFiles(files) {
  const byName = new Map();
  for (const file of files ?? []) {
    byName.set(basename(file.originalname).toLowerCase(), file);
  }
  return byName;
}

/** Pull the named resume out of the uploaded files, or out of an attached ZIP. */
function resumeForRow(row, uploadedByName, zipEntries, zipBuffer) {
  if (!row.resumeFilename) return null;
  const wanted = basename(row.resumeFilename).toLowerCase();

  const uploaded = uploadedByName.get(wanted);
  if (uploaded?.buffer?.length) return { buffer: uploaded.buffer, filename: wanted };

  const entry = zipEntries.find((candidate) => basename(candidate.name).toLowerCase() === wanted);
  if (!entry) return null;
  try {
    return { buffer: readZipEntry(zipBuffer, entry), filename: wanted };
  } catch {
    return null;
  }
}

/**
 * Import candidates from a CSV, attaching resumes when a row names one and the
 * file was uploaded alongside (loose files or one ZIP). A named-but-missing resume
 * is not an error — the candidate is still worth having.
 */
export async function importCandidatesFromCsv(companyId, posting, csvBuffer, { resumeFiles = [], resumeZip = null } = {}) {
  const { rows, errors, missing } = parseCandidateCsv(csvBuffer, { isValidEmail });
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `The CSV is missing required columns: ${missing.join(', ')}.`,
      'MISSING_COLUMNS',
    );
  }
  if (rows.length === 0 && errors.length === 0) {
    throw new HttpError(400, 'This CSV has no candidate rows.', 'EMPTY_CSV');
  }

  const stage = await requireDefaultStage(companyId);
  const summary = createImportSummary();
  for (const error of errors) recordFailure(summary, error.filename, error.reason);

  const uploadedByName = indexResumeFiles(resumeFiles);
  let zipEntries = [];
  if (resumeZip?.buffer?.length) {
    try {
      zipEntries = listZipEntries(resumeZip.buffer).filter((entry) => !isArchiveNoise(entry.name));
    } catch {
      recordFailure(summary, resumeZip.originalname ?? 'resumes.zip', 'Could not read the resume archive.');
    }
  }

  for (const row of rows) {
    const resume = resumeForRow(row, uploadedByName, zipEntries, resumeZip?.buffer);
    await applyRowToSummary(summary, companyId, posting, stage, row, { resume });
  }

  return toPublicSummary(summary);
}
