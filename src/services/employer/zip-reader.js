// FILE: src/services/employer/zip-reader.js
// A read-only ZIP reader over a Buffer, built on Node's zlib. No dependency is
// added for this: the archive we accept is a flat bag of PDFs a recruiter exported
// from their inbox, and that needs the central directory plus two compression
// methods (store and deflate) — not a general archive library.
//
// The CENTRAL DIRECTORY is the source of truth for every size and name. Local
// headers may carry zeroes when a writer used a data descriptor, so reading sizes
// from them is the classic way to end up with truncated files.

import zlib from 'zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {}

/** Locate the end-of-central-directory record, scanning back from the tail. */
function findEndOfCentralDirectory(buffer) {
  // 22 bytes minimum, plus up to 64KB of trailing comment.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipError('This file is not a valid ZIP archive.');
}

/** Decompress one entry's bytes using its declared method. */
function inflateEntry(buffer, start, compressedSize, method) {
  const slice = buffer.subarray(start, start + compressedSize);
  if (method === STORED) return Buffer.from(slice);
  if (method === DEFLATED) return zlib.inflateRawSync(slice);
  throw new ZipError(`Unsupported compression method ${method}.`);
}

/**
 * List the archive's file entries WITHOUT decompressing them: name, sizes, and
 * where the bytes begin. Directories and zero-byte entries are dropped.
 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new ZipError('This file is not a valid ZIP archive.');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
    throw new ZipError('ZIP64 archives are not supported. Export a smaller archive.');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError('This ZIP archive is damaged and could not be read.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (!name.endsWith('/') && uncompressedSize > 0) {
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress one entry listed by listZipEntries. Throws ZipError on a bad entry. */
export function readZipEntry(buffer, entry) {
  const { localOffset } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    throw new ZipError('Entry is damaged.');
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  try {
    return inflateEntry(buffer, dataStart, entry.compressedSize, entry.method);
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError('Entry could not be decompressed.');
  }
}

/** The bare filename, with any directory path stripped. */
export const basename = (name) => String(name).split(/[\\/]/).pop();

/** A file the import should ignore rather than report: OS and archiver noise. */
export function isArchiveNoise(name) {
  const base = basename(name);
  return name.startsWith('__MACOSX/') || base.startsWith('._') || base === '.DS_Store' || !base;
}
