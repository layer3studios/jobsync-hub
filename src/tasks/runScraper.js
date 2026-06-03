// FILE: src/tasks/runScraper.js
// Orchestrates a full scrape pass across every configured ATS.

import { SITES_CONFIG } from '../config.js';
import { loadAllExistingIDs, deleteOldJobs, deleteExpiredJobs } from '../Db/jobs/index.js';
import { scrapeSite } from '../core/scraperEngine.js';

let isScraping = false;

export async function runScraper() {
  if (isScraping) {
    console.log('[scraper] already running — skipping');
    return;
  }
  isScraping = true;
  console.log('[scraper] starting');

  try {
    const existingIDsMap = await loadAllExistingIDs();

    for (const siteConfig of SITES_CONFIG) {
      if (!siteConfig?.siteName) continue;

      const { newJobs, seenJobIds, scrapedSuccessfully } =
        await scrapeSite(siteConfig, existingIDsMap);

      console.log(`[${siteConfig.siteName}] ${newJobs.length} new jobs`);

      if (scrapedSuccessfully && seenJobIds.size > 0) {
        await deleteExpiredJobs(siteConfig.siteName, seenJobIds);
      } else {
        console.log(`[${siteConfig.siteName}] scrape incomplete — 7-day fallback cleanup`);
        await deleteOldJobs(siteConfig.siteName);
      }
    }

    console.log('[scraper] all sites done');
  } catch (err) {
    console.error('[scraper] error:', err);
  } finally {
    isScraping = false;
  }
}
