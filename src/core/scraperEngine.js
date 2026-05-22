import { initializeSession, fetchJobsPage } from './network.js';
import { shouldContinuePaging } from './pagination.js';
import { processJob } from './processor.js';
import { saveJobs } from "../Db/databaseManager.js";
import { sleep } from '../utils.js';

export async function scrapeSite(siteConfig, existingIDsMap) {
    const siteName = siteConfig.siteName;
    const existingIDs = existingIDsMap.get(siteName) || new Set();
    const seenInRun = new Set();
    const savedInRun = new Set();
    const allNewJobs = [];
    const PROCESS_CONCURRENCY = 10;

    const limit = siteConfig.limit || 20;
    let offset = 0;
    let hasMore = true;
    let totalJobs = 0;
    try {
        const sessionHeaders = await initializeSession(siteConfig);

        while (hasMore) {
            const scrapeStartTime = new Date();
            console.log(`[${siteName}] Fetching page with offset: ${offset}...`);
            let data;
            try {
                data = await fetchJobsPage(siteConfig, offset, limit, sessionHeaders);
            } catch (pageError) {
                console.warn(`[${siteName}] Skipping offset ${offset}: ${pageError.message}`);
                hasMore = shouldContinuePaging(siteConfig, [], offset, limit, totalJobs);
                offset += limit;
                continue;
            }

            // null means a skippable error (e.g. 404 for one Lever company).
            // Do NOT break — just advance to the next page/company.
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

            if (offset === 0 && siteConfig.getTotal) {
                totalJobs = siteConfig.getTotal(data);
            }

            const collectedForPage = [];

            if (offset === 0 && siteConfig.getTotal) {
                totalJobs = siteConfig.getTotal(data);
            }


            for (let i = 0; i < jobs.length; i += PROCESS_CONCURRENCY) {
                const chunk = jobs.slice(i, i + PROCESS_CONCURRENCY);
                const processedJobs = await Promise.all(
                    chunk.map(rawJob => processJob(rawJob, siteConfig, existingIDs, sessionHeaders, seenInRun))
                );

                for (const job of processedJobs) {
                    if (!job?.JobID) continue;
                    if (savedInRun.has(job.JobID)) continue;
                    savedInRun.add(job.JobID);
                    collectedForPage.push(job);
                }
            }

            if (collectedForPage.length > 0) {
                console.log(`   -> Saving ${collectedForPage.length} valid job(s)...`);
                const jobsToSave = collectedForPage.map(job => ({ ...job, scrapedAt: scrapeStartTime }));
                await saveJobs(jobsToSave);

                allNewJobs.push(...collectedForPage);
                collectedForPage.forEach(job => existingIDs.add(job.JobID));
            }

            // Small inter-page pause to reduce ATS pressure without per-job slowdown
            await sleep(350);
            
            hasMore = shouldContinuePaging(siteConfig, jobs, offset, limit, totalJobs);
            offset += limit;
        }
    } catch (error) {
        console.error(`[${siteName}] ERROR during scrape: ${error.message}.`);
        return { newJobs: allNewJobs, seenJobIds: seenInRun, scrapedSuccessfully: false };
    }

    if (allNewJobs.length > 0) {
        console.log(`\n[${siteName}] Finished. Found ${allNewJobs.length} new jobs. Total seen this run: ${seenInRun.size}`);
    } else {
        console.log(`\n[${siteName}] No new jobs found. Total seen this run: ${seenInRun.size}`);
    }
    return { newJobs: allNewJobs, seenJobIds: seenInRun, scrapedSuccessfully: true };
}