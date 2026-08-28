// FILE: src/services/admin/scraper-health-service.js
// Reads for the admin Scraper Health dashboard. The route stays thin: every
// query and every fold lives here, and the pure folds are exported separately
// so they can be tested without a database.
//
// Corpus figures deliberately cover SCRAPED jobs only (`sourceSite` exists).
// The `jobs` collection is shared with native employer postings, which the
// scraper never touches and which would skew every percentage.

import { col } from '../../Db/connection.js';
import { findScrapeRuns } from '../../models/admin/scrape-run-model.js';

const AVG_WINDOW = 7;          // successful runs averaged for the volume baseline
const ANOMALY_RATIO = 0.3;     // latest below 30% of the average reads as a drop
const MIN_HISTORY = 3;         // fewer prior successful runs → never anomalous
const SUMMARY_SCAN_LIMIT = 500;
const SCRAPED = { sourceSite: { $exists: true } };

const percent = (numerator, denominator) =>
  (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0);

/** Newest first. `limit` is clamped by the route, not here. */
export async function listRecentRuns({ siteName, limit = 50 } = {}) {
  return findScrapeRuns({ siteName, limit });
}

/**
 * Fold one site's runs (already newest-first) into its dashboard row.
 * Exported for tests; `getSiteSummaries` is the DB-backed caller.
 */
export function summariseSiteRuns(siteName, runs = []) {
  const successful = runs.filter((run) => run.scrapedSuccessfully);
  const lastRun = runs[0] ?? null;
  const lastSuccessfulRun = successful[0] ?? null;

  const window = successful.slice(0, AVG_WINDOW);
  const avgNewJobs = window.length > 0
    ? Math.round((window.reduce((sum, run) => sum + (run.newJobs ?? 0), 0) / window.length) * 10) / 10
    : 0;

  // "Historical" means the successful runs BEFORE the latest one — a site with
  // too little history has no baseline to be anomalous against.
  const historyCount = Math.max(0, successful.length - 1);
  const latestNewJobs = lastSuccessfulRun?.newJobs ?? 0;
  const isVolumeAnomalous = historyCount >= MIN_HISTORY
    && avgNewJobs > 0
    && latestNewJobs < avgNewJobs * ANOMALY_RATIO;

  return {
    siteName,
    lastRun,
    lastSuccessfulRun,
    latestNewJobs,
    avgNewJobs,
    successfulRunCount: successful.length,
    isVolumeAnomalous,
    lastRunFailed: Boolean(lastRun) && !lastRun.scrapedSuccessfully,
    errorMessage: lastRun?.scrapedSuccessfully ? null : (lastRun?.errorMessage ?? null),
  };
}

/** Group a flat, newest-first run list by site, preserving order within a site. */
export function summariseRuns(runs = []) {
  const bySite = new Map();
  for (const run of runs) {
    if (!bySite.has(run.siteName)) bySite.set(run.siteName, []);
    bySite.get(run.siteName).push(run);
  }
  return [...bySite.entries()]
    .map(([siteName, siteRuns]) => summariseSiteRuns(siteName, siteRuns))
    .sort((a, b) => a.siteName.localeCompare(b.siteName));
}

/** One row per site that has ever recorded a run. */
export async function getSiteSummaries() {
  const runs = await findScrapeRuns({ limit: SUMMARY_SCAN_LIMIT });
  return summariseRuns(runs);
}

/** Shape the single $facet result into the dashboard's corpus strip. */
export function buildCorpusQuality(facet = {}) {
  const totals = facet.totals?.[0] ?? {};
  const totalJobs = totals.totalJobs ?? 0;
  return {
    totalJobs,
    cleanedCount: totals.cleaned ?? 0,
    taggedCount: totals.tagged ?? 0,
    salaryCount: totals.salary ?? 0,
    pctCleaned: percent(totals.cleaned ?? 0, totalJobs),
    pctTagged: percent(totals.tagged ?? 0, totalJobs),
    pctSalary: percent(totals.salary ?? 0, totalJobs),
    duplicateJobIds: facet.duplicates?.[0]?.count ?? 0,
  };
}

/**
 * Corpus-wide quality counters in one pass. Field names come from
 * src/models/shared/job-model.js: DescriptionCleaned, autoTags, SalaryMin/Max.
 * "Tagged" means the tagger actually classified the job — a bare
 * roleCategory of 'Other' with no tech stack is the untagged default.
 */
export async function getCorpusQuality() {
  const jobs = await col('jobs');
  const [facet] = await jobs.aggregate([
    { $match: SCRAPED },
    {
      $facet: {
        totals: [{
          $group: {
            _id: null,
            totalJobs: { $sum: 1 },
            cleaned: {
              $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$DescriptionCleaned', ''] } }, 0] }, 1, 0] },
            },
            tagged: {
              $sum: {
                $cond: [{
                  $or: [
                    { $gt: [{ $size: { $ifNull: ['$autoTags.techStack', []] } }, 0] },
                    { $not: [{ $in: [{ $ifNull: ['$autoTags.roleCategory', 'Other'] }, ['Other', '']] }] },
                  ],
                }, 1, 0],
              },
            },
            salary: {
              $sum: {
                $cond: [{
                  $or: [
                    { $gt: [{ $ifNull: ['$SalaryMin', 0] }, 0] },
                    { $gt: [{ $ifNull: ['$SalaryMax', 0] }, 0] },
                  ],
                }, 1, 0],
              },
            },
          },
        }],
        duplicates: [
          { $group: { _id: '$JobID', n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } },
          { $count: 'count' },
        ],
      },
    },
  ]).toArray();

  return buildCorpusQuality(facet);
}

export default getSiteSummaries;
