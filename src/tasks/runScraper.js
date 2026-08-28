// FILE: src/tasks/runScraper.js
// Orchestrates a full scrape pass across every configured ATS, in two phases.
//
// Phase 1 FETCH — every site is scraped and cleaned up. This never touches AI,
//   so it always completes regardless of quota.
// Phase 2 PARSE — the accumulated new jobs get their JDs extracted, gated by
//   SCRAPER_JD_EXTRACTION_ENABLED and stoppable by rate limits.
//
// The split matters: previously a rate limit hit while parsing site #2 meant
// sites #3+ were never even FETCHED. Now a quota wall costs only parsing, and
// the unparsed jobs are picked up next run (extraction is idempotent).

import { SITES_CONFIG } from '../config.js';
import { loadAllExistingIDs, deleteOldJobs, deleteExpiredJobs } from '../Db/jobs/index.js';
import { scrapeSite } from '../core/scraperEngine.js';
import { runParsePhase } from './scraper-parse-phase.js';
import { newRunId, recordScrapeRun } from '../models/admin/scrape-run-model.js';

let isScraping = false;

/** Live view of the scrape lock, for the admin health dashboard's run-now route. */
export const isScraperRunning = () => isScraping;

/**
 * Phase 1: scrape + clean up every site, accumulating the new jobs.
 * Each site also emits one scrape_runs row. The recording is fire-and-forget
 * (recordScrapeRun swallows its own errors) and a site error is re-thrown
 * unchanged after being recorded, so the loop's control flow is untouched.
 */
async function fetchAllSites(existingIDsMap, runId) {
  const allNewJobs = [];

  for (const siteConfig of SITES_CONFIG) {
    if (!siteConfig?.siteName) continue;

    const startedAt = new Date();
    let seen = 0;
    let fetchedNewJobs = 0;
    let deletedExpired = 0;

    try {
      const { newJobs, seenJobIds, scrapedSuccessfully } = await scrapeSite(siteConfig, existingIDsMap);
      console.log(`[${siteConfig.siteName}] ${newJobs.length} new jobs`);
      allNewJobs.push(...newJobs);
      seen = seenJobIds.size;
      fetchedNewJobs = newJobs.length;

      // Cleanup stays per-site and immediate — it depends on that site's crawl.
      if (scrapedSuccessfully && seenJobIds.size > 0) {
        deletedExpired = await deleteExpiredJobs(siteConfig.siteName, seenJobIds);
      } else {
        console.log(`[${siteConfig.siteName}] scrape incomplete — 7-day fallback cleanup`);
        deletedExpired = await deleteOldJobs(siteConfig.siteName);
      }

      await recordScrapeRun({
        runId,
        siteName: siteConfig.siteName,
        startedAt,
        jobsFetched: seen,
        newJobs: fetchedNewJobs,
        deletedExpired,
        scrapedSuccessfully,
        errorMessage: null,
      });
    } catch (err) {
      await recordScrapeRun({
        runId,
        siteName: siteConfig.siteName,
        startedAt,
        jobsFetched: seen,
        newJobs: fetchedNewJobs,
        deletedExpired,
        scrapedSuccessfully: false,
        errorMessage: err?.message ?? String(err),
      });
      throw err;
    }
  }

  return allNewJobs;
}

export async function runScraper() {
  if (isScraping) {
    console.log('[scraper] already running — skipping');
    return;
  }
  isScraping = true;
  console.log('[scraper] starting');

  try {
    const existingIDsMap = await loadAllExistingIDs();

    const allNewJobs = await fetchAllSites(existingIDsMap, newRunId());
    console.log(`[scraper] fetched ${allNewJobs.length} new jobs across all sites`);

    await runParsePhase(allNewJobs);

    console.log('[scraper] all sites done');
  } catch (err) {
    console.error('[scraper] error:', err);
  } finally {
    isScraping = false;
  }
}
