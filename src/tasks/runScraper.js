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

let isScraping = false;

/** Phase 1: scrape + clean up every site, accumulating the new jobs. */
async function fetchAllSites(existingIDsMap) {
  const allNewJobs = [];

  for (const siteConfig of SITES_CONFIG) {
    if (!siteConfig?.siteName) continue;

    const { newJobs, seenJobIds, scrapedSuccessfully } = await scrapeSite(siteConfig, existingIDsMap);
    console.log(`[${siteConfig.siteName}] ${newJobs.length} new jobs`);
    allNewJobs.push(...newJobs);

    // Cleanup stays per-site and immediate — it depends on that site's crawl.
    if (scrapedSuccessfully && seenJobIds.size > 0) {
      await deleteExpiredJobs(siteConfig.siteName, seenJobIds);
    } else {
      console.log(`[${siteConfig.siteName}] scrape incomplete — 7-day fallback cleanup`);
      await deleteOldJobs(siteConfig.siteName);
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

    const allNewJobs = await fetchAllSites(existingIDsMap);
    console.log(`[scraper] fetched ${allNewJobs.length} new jobs across all sites`);

    await runParsePhase(allNewJobs);

    console.log('[scraper] all sites done');
  } catch (err) {
    console.error('[scraper] error:', err);
  } finally {
    isScraping = false;
  }
}
