// FILE: src/core/scraperEngine.js
// Orchestrates a single site's scrape: paginate, process, save, repeat.

import { initializeSession, fetchJobsPage } from './network.js';
import { shouldContinuePaging } from './pagination.js';
import { processJob } from './processor/index.js';
import { saveJobs } from '../Db/jobs/index.js';
import { sleep } from '../utils.js';

const PROCESS_CONCURRENCY = 10;
const INTER_PAGE_DELAY_MS = 350;

export async function scrapeSite(siteConfig, existingIDsMap) {
  const siteName = siteConfig.siteName;
  const existingIDs = existingIDsMap.get(siteName) || new Set();
  const seenInRun = new Set();
  const savedInRun = new Set();
  const newJobs = [];

  const limit = siteConfig.limit || 20;
  let offset = 0;
  let hasMore = true;
  let totalJobs = 0;

  try {
    const sessionHeaders = await initializeSession(siteConfig);

    while (hasMore) {
      const scrapeStartTime = new Date();
      console.log(`[${siteName}] fetching offset=${offset}`);

      let data;
      try {
        data = await fetchJobsPage(siteConfig, offset, limit, sessionHeaders);
      } catch (err) {
        console.warn(`[${siteName}] skip offset ${offset}: ${err.message}`);
        hasMore = shouldContinuePaging(siteConfig, [], offset, limit, totalJobs);
        offset += limit;
        continue;
      }

      // null = skippable error (404 for a single Lever company, etc.)
      if (data === null) {
        hasMore = shouldContinuePaging(siteConfig, [], offset, limit, totalJobs);
        offset += limit;
        continue;
      }

      const jobs = siteConfig.getJobs(data);

      if (!jobs || jobs.length === 0) {
        if (siteConfig.ignoreLengthCheck) {
          hasMore = shouldContinuePaging(siteConfig, [], offset, limit, totalJobs);
          offset += limit;
          continue;
        }
        break;
      }

      // FIX: previous code captured totalJobs twice in the same iteration.
      if (offset === 0 && siteConfig.getTotal) {
        totalJobs = siteConfig.getTotal(data);
      }

      const collected = [];
      for (let i = 0; i < jobs.length; i += PROCESS_CONCURRENCY) {
        const chunk = jobs.slice(i, i + PROCESS_CONCURRENCY);
        const processed = await Promise.all(
          chunk.map(raw => processJob(raw, siteConfig, existingIDs, sessionHeaders, seenInRun)),
        );
        for (const job of processed) {
          if (!job?.JobID || savedInRun.has(job.JobID)) continue;
          savedInRun.add(job.JobID);
          collected.push(job);
        }
      }

      if (collected.length > 0) {
        console.log(`[${siteName}] saving ${collected.length} job(s)`);
        await saveJobs(collected.map(j => ({ ...j, scrapedAt: scrapeStartTime })));
        newJobs.push(...collected);
        collected.forEach(j => existingIDs.add(j.JobID));
      }

      await sleep(INTER_PAGE_DELAY_MS);
      hasMore = shouldContinuePaging(siteConfig, jobs, offset, limit, totalJobs);
      offset += limit;
    }
  } catch (err) {
    console.error(`[${siteName}] scrape error: ${err.message}`);
    return { newJobs, seenJobIds: seenInRun, scrapedSuccessfully: false };
  }

  console.log(`[${siteName}] done — ${newJobs.length} new / ${seenInRun.size} seen`);
  return { newJobs, seenJobIds: seenInRun, scrapedSuccessfully: true };
}
