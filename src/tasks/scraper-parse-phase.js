// FILE: src/tasks/scraper-parse-phase.js
// Phase 2 of a scrape pass: parse the JDs collected in phase 1.
//
// Separated from fetching on purpose. Fetching is cheap and must ALWAYS run;
// parsing spends AI quota and can stop dead partway through. When the cascade
// reports every model rate-limited we break immediately — continuing would burn
// the loop re-discovering the same wall. Whatever is left is picked up on the
// next cron run, because extractAndStoreRequirements skips docs that already
// carry parsedRequirements.

import { SCRAPER_JD_EXTRACTION_ENABLED } from '../env.js';
import { extractAndStoreRequirements as defaultExtract } from '../gemma/background-extractor.js';
import { getScraperAiClient as defaultGetClient } from '../gemma/gemma-runtime.js';

const RATE_LIMIT_MARKER = 'All models rate-limited';

/**
 * Parse every job sequentially. Returns { parsed, skipped, failed } and never
 * throws — the scrape pass must survive any extraction problem.
 */
export async function runParsePhase(allNewJobs, deps = {}) {
  const {
    getClient = defaultGetClient,
    extractAndStoreRequirements = defaultExtract,
    enabled = SCRAPER_JD_EXTRACTION_ENABLED,
  } = deps;

  if (!enabled) {
    console.log('[scraper] JD extraction disabled — skipping parse phase');
    return { parsed: 0, skipped: 0, failed: 0 };
  }
  if (!Array.isArray(allNewJobs) || allNewJobs.length === 0) {
    return { parsed: 0, skipped: 0, failed: 0 };
  }

  const client = getClient();
  if (!client) {
    console.log('[scraper] no AI client — skipping parse');
    return { parsed: 0, skipped: allNewJobs.length, failed: 0 };
  }

  let parsed = 0;
  let failed = 0;
  let skipped = 0;

  for (let index = 0; index < allNewJobs.length; index += 1) {
    const job = allNewJobs[index];
    try {
      await extractAndStoreRequirements(job, client);
      parsed += 1;
    } catch (err) {
      if (String(err?.message ?? '').includes(RATE_LIMIT_MARKER)) {
        skipped = allNewJobs.length - index; // this job and every one after it
        console.log(`[scraper] rate limit reached after ${parsed} jobs, ${skipped} skipped`);
        break;
      }
      // A single bad JD is processed-and-failed, not a reason to stop.
      failed += 1;
      console.warn(`[scraper] extraction failed for ${job?.JobID ?? job?._id}: ${err.message}`);
    }
  }

  console.log(`[scraper] parse complete: ${parsed + failed} processed, ${skipped} skipped`);
  return { parsed, skipped, failed };
}

export default runParsePhase;
