// FILE: src/core/processor/index.js
// Per-job pipeline: map raw ATS payload → mapped job → filtered → saved as IJob.

import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import { AbortController } from 'abort-controller';

import { createJobModel } from '../../models/jobModel.js';
import { selectMapper } from './mappers/index.js';
import { isSpamOrIrrelevant, isTechRole, inferExperienceLevel } from './filters.js';

const PAGE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Fall back to scraping the job's public page for a description when the API
 * doesn't include one. Used by configs without their own getDetails handler.
 */
async function scrapeJobDetailsFromPage(mappedJob, siteConfig) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    console.log(`[${siteConfig.siteName}] fetching ${mappedJob.ApplicationURL}`);
    const res = await fetch(mappedJob.ApplicationURL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    if (siteConfig.descriptionSelector) {
      const el = doc.querySelector(siteConfig.descriptionSelector);
      if (el) mappedJob.Description = el.textContent.replace(/\s+/g, ' ').trim();
    }
  } catch (err) {
    console.error(`[${siteConfig.siteName}] page fetch error: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  return mappedJob;
}

/**
 * Map raw job → JobMesh-shaped job (without saving).
 * Returns null when the platform is unknown and config has no legacy extractors.
 */
function mapJob(rawJob, siteConfig) {
  const platform = selectMapper(siteConfig.siteName);

  if (platform) {
    const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteConfig.siteName;
    const jobId = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : platform.getJobIdFallback(rawJob);
    const mapped = platform.mapper(rawJob, companyName, siteConfig.siteName);
    mapped.JobID = jobId;

    // If the config supplied its own extractPostedDate, prefer that over the
    // platform mapper's default. The platform mappers use generic field names
    // (e.g. `created_at`) but some ATS APIs use different names (e.g. Workable
    // returns `created`, not `created_at`). The per-config function knows the
    // actual shape.
    if (typeof siteConfig.extractPostedDate === 'function') {
      const customDate = siteConfig.extractPostedDate(rawJob);
      if (customDate) {
        const parsed = customDate instanceof Date ? customDate : new Date(customDate);
        if (!Number.isNaN(parsed.getTime())) mapped.PostedDate = parsed;
      }
    }
    return mapped;
  }

  // Legacy: site config provides its own extractors
  if (siteConfig.extractJobID) {
    return {
      JobID: siteConfig.extractJobID(rawJob),
      JobTitle: siteConfig.extractJobTitle(rawJob),
      Company: siteConfig.extractCompany(rawJob),
      Location: siteConfig.extractLocation(rawJob),
      Description: siteConfig.extractDescription(rawJob),
      ApplicationURL: siteConfig.extractURL(rawJob),
      PostedDate: siteConfig.extractPostedDate ? siteConfig.extractPostedDate(rawJob) : null,
    };
  }

  return siteConfig.mapper ? siteConfig.mapper(rawJob) : null;
}

/**
 * Process a single raw job from a site config.
 * Returns a saveable IJob, or null when rejected/duplicate.
 */
export async function processJob(rawJob, siteConfig, existingIDs, sessionHeaders, seenInRun) {
  // 1. Pre-filter from config
  if (siteConfig.preFilter && !siteConfig.preFilter(rawJob)) return null;

  // 2. Map to JobMesh shape
  let mapped = mapJob(rawJob, siteConfig);
  if (!mapped?.JobID) return null;

  if (seenInRun instanceof Set) seenInRun.add(mapped.JobID);

  // 3. Skip if already in DB
  if (existingIDs.has(mapped.JobID)) return null;

  // 4. Spam filter
  if (isSpamOrIrrelevant(mapped.JobTitle)) {
    console.log(`[filter] spam: ${mapped.JobTitle}`);
    return null;
  }

  // 5. Tech-role gate
  if (!isTechRole(mapped.JobTitle)) {
    console.log(`[filter] non-tech: ${mapped.JobTitle}`);
    return null;
  }

  // 6. Tagging
  mapped.ExperienceLevel = mapped.ExperienceLevel || inferExperienceLevel(mapped.JobTitle);

  // 7. Keyword match (site-config specific)
  if (siteConfig.filterKeywords?.length > 0) {
    const titleLower = mapped.JobTitle.toLowerCase();
    if (!siteConfig.filterKeywords.some(kw => titleLower.includes(kw.toLowerCase()))) return null;
  }

  // 8. Fetch description if not already present
  if (siteConfig.needsDescriptionScraping && !mapped.Description) {
    if (typeof siteConfig.getDetails === 'function') {
      try {
        const details = await siteConfig.getDetails(rawJob, sessionHeaders);
        if (details?.skip) {
          console.log(`[${siteConfig.siteName}] getDetails returned skip`);
          return null;
        }
        if (details) Object.assign(mapped, details);
      } catch (err) {
        console.error(`[${siteConfig.siteName}] getDetails: ${err.message}`);
        return null;
      }
    } else {
      mapped = await scrapeJobDetailsFromPage(mapped, siteConfig);
    }
  }

  if (!mapped.Description) return null;

  mapped.Status = 'active';
  return createJobModel(mapped, siteConfig.siteName);
}
