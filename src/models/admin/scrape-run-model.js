// FILE: src/models/admin/scrape-run-model.js
// One document per SITE per scrape pass, in `scrape_runs`. Every site of a
// single runScraper() invocation shares one runId, so a pass can be read back
// either as a whole or site-by-site.
//
// FIRE-AND-FORGET: recordScrapeRun swallows its own errors. A telemetry write
// must never fail or delay the scrape it describes — losing a run row is
// strictly better than losing the crawl it was measuring.
//
// Retention rides `startedAtExpiry`, a real Date, the same technique
// gemma/usage-stats.js uses for its daily rows.

import { randomUUID } from 'node:crypto';
import { col } from '../../Db/connection.js';

const COLLECTION = 'scrape_runs';
const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

const runsCol = () => col(COLLECTION);

/** A fresh id shared by every site row of one scrape pass. */
export const newRunId = () => randomUUID();

/** Idempotent index setup. Called from server boot. */
export async function ensureScrapeRunIndexes() {
  const collection = await runsCol();
  await collection.createIndex(
    { siteName: 1, startedAt: -1 },
    { name: 'scrape_runs_site_started' },
  );
  await collection.createIndex(
    { startedAtExpiry: 1 },
    { expireAfterSeconds: 0, name: 'scrape_runs_ttl' },
  );
}

/** Coerce to a finite non-negative integer; anything else counts as zero. */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Anything unparseable becomes `now` — a run row is never worth losing. */
function toDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/** The moment this row becomes eligible for TTL removal. */
const expiryFor = (startedAt) => new Date(startedAt.getTime() + RETENTION_DAYS * MS_PER_DAY);

/**
 * Persist one site's slice of a scrape pass. Returns the inserted document on
 * success and null when the write failed — callers are not expected to check.
 */
export async function recordScrapeRun({
  runId,
  siteName,
  startedAt,
  finishedAt = new Date(),
  jobsFetched,
  newJobs,
  deletedExpired,
  scrapedSuccessfully = false,
  errorMessage = null,
} = {}) {
  try {
    const started = toDate(startedAt);
    const finished = toDate(finishedAt, started);
    const doc = {
      runId,
      siteName,
      startedAt: started,
      finishedAt: finished,
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      jobsFetched: count(jobsFetched),
      newJobs: count(newJobs),
      deletedExpired: count(deletedExpired),
      scrapedSuccessfully: Boolean(scrapedSuccessfully),
      errorMessage: errorMessage ? String(errorMessage) : null,
      startedAtExpiry: expiryFor(started),
    };
    const collection = await runsCol();
    await collection.insertOne(doc);
    return doc;
  } catch (err) {
    // Never propagate: this is telemetry, not the payload.
    console.warn(`[scrape-runs] run write failed: ${err.message}`);
    return null;
  }
}

/** Raw run rows, newest first. Service-layer shaping lives elsewhere. */
export async function findScrapeRuns({ siteName, limit = 50 } = {}) {
  const collection = await runsCol();
  const filter = siteName ? { siteName } : {};
  return collection.find(filter, { projection: { startedAtExpiry: 0 } })
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();
}

export default recordScrapeRun;
