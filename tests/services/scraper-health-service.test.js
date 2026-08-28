// FILE: tests/services/scraper-health-service.test.js
// Site summaries, the volume-anomaly rule and its edge cases, and the corpus
// aggregation. The folds are pure, so most of this needs no database.
import './../_helpers/test-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  summariseSiteRuns, summariseRuns, buildCorpusQuality,
  getCorpusQuality, getSiteSummaries, listRecentRuns,
} from '../../src/services/admin/scraper-health-service.js';
import { ensureScrapeRunIndexes, recordScrapeRun } from '../../src/models/admin/index.js';

/** Newest-first run rows; `newJobsSeries[0]` is the latest. */
const runsOf = (newJobsSeries, { ok = true } = {}) => newJobsSeries.map((newJobs, i) => ({
  runId: `r${i}`,
  siteName: 'ashby',
  newJobs,
  startedAt: new Date(Date.now() - i * 1000),
  scrapedSuccessfully: ok,
  errorMessage: null,
}));

after(async () => { await closeTestDb(); });

test('a site with no runs summarises to empty rather than throwing', () => {
  const row = summariseSiteRuns('ashby', []);
  assert.equal(row.lastRun, null);
  assert.equal(row.lastSuccessfulRun, null);
  assert.equal(row.avgNewJobs, 0);
  assert.equal(row.isVolumeAnomalous, false);
  assert.equal(row.lastRunFailed, false);
});

test('avgNewJobs averages at most the last 7 successful runs', () => {
  // 8 runs; the oldest (1000) must fall outside the window.
  const row = summariseSiteRuns('ashby', runsOf([10, 10, 10, 10, 10, 10, 10, 1000]));
  assert.equal(row.avgNewJobs, 10);
  assert.equal(row.latestNewJobs, 10);
});

test('a latest run below 30% of the average is flagged as a volume drop', () => {
  const row = summariseSiteRuns('ashby', runsOf([2, 100, 100, 100]));
  // avg over the 4 successful runs = 75.5; 2 < 22.65
  assert.equal(row.avgNewJobs, 75.5);
  assert.equal(row.isVolumeAnomalous, true);
});

test('a latest run at or above 30% of the average is not flagged', () => {
  const row = summariseSiteRuns('ashby', runsOf([40, 100, 100, 100]));
  assert.equal(row.isVolumeAnomalous, false);
});

test('fewer than 3 HISTORICAL successful runs is never anomalous', () => {
  // 3 successful rows = only 2 prior to the latest, so there is no baseline yet.
  const thin = summariseSiteRuns('ashby', runsOf([0, 100, 100]));
  assert.equal(thin.successfulRunCount, 3);
  assert.equal(thin.isVolumeAnomalous, false);
  // A single run, and no runs at all, likewise.
  assert.equal(summariseSiteRuns('ashby', runsOf([0, 100])).isVolumeAnomalous, false);
  assert.equal(summariseSiteRuns('ashby', runsOf([0])).isVolumeAnomalous, false);
  // One more prior run tips it over the threshold.
  assert.equal(summariseSiteRuns('ashby', runsOf([0, 100, 100, 100])).isVolumeAnomalous, true);
});

test('an all-zero history cannot be anomalous (no positive baseline)', () => {
  assert.equal(summariseSiteRuns('ashby', runsOf([0, 0, 0, 0, 0])).isVolumeAnomalous, false);
});

test('failed runs are excluded from the average but drive lastRunFailed', () => {
  const runs = [
    {
      runId: 'f0', siteName: 'ashby', newJobs: 0, startedAt: new Date(3000),
      scrapedSuccessfully: false, errorMessage: 'HTTP 503',
    },
    ...runsOf([50, 50, 50, 50]).map((run, i) => ({ ...run, startedAt: new Date(2000 - i) })),
  ];
  const row = summariseSiteRuns('ashby', runs);
  assert.equal(row.lastRunFailed, true);
  assert.equal(row.errorMessage, 'HTTP 503');
  assert.equal(row.avgNewJobs, 50);                  // the failure is not averaged in
  assert.equal(row.lastSuccessfulRun.runId, 'r0');   // newest SUCCESSFUL row
  assert.equal(row.isVolumeAnomalous, false);
});

test('summariseRuns groups a flat list by site, alphabetically', () => {
  const rows = summariseRuns([
    { siteName: 'lever', newJobs: 5, startedAt: new Date(3000), scrapedSuccessfully: true },
    { siteName: 'ashby', newJobs: 7, startedAt: new Date(2000), scrapedSuccessfully: true },
    { siteName: 'lever', newJobs: 9, startedAt: new Date(1000), scrapedSuccessfully: true },
  ]);
  assert.deepEqual(rows.map((row) => row.siteName), ['ashby', 'lever']);
  assert.equal(rows[1].latestNewJobs, 5);   // newest lever row wins
  assert.equal(rows[1].avgNewJobs, 7);      // (5 + 9) / 2
});

test('buildCorpusQuality turns an empty facet into zeroes, not NaN', () => {
  const corpus = buildCorpusQuality({ totals: [], duplicates: [] });
  assert.equal(corpus.totalJobs, 0);
  assert.equal(corpus.pctCleaned, 0);
  assert.equal(corpus.pctTagged, 0);
  assert.equal(corpus.pctSalary, 0);
  assert.equal(corpus.duplicateJobIds, 0);
});

test('getCorpusQuality counts cleaned / tagged / salary / duplicates over scraped jobs', async () => {
  await dropCollections('jobs');
  const jobs = await col('jobs');
  await jobs.insertMany([
    // Fully enriched.
    {
      JobID: 'a', sourceSite: 'ashby', DescriptionCleaned: '<p>hi</p>',
      autoTags: { techStack: ['node'], roleCategory: 'Engineering' }, SalaryMin: 100, SalaryMax: 200,
    },
    // Cleaned only; the default 'Other' with no tech stack does NOT count as tagged.
    {
      JobID: 'b', sourceSite: 'ashby', DescriptionCleaned: 'text',
      autoTags: { techStack: [], roleCategory: 'Other' }, SalaryMin: null, SalaryMax: null,
    },
    // Nothing at all.
    { JobID: 'c', sourceSite: 'lever' },
    // Duplicate JobID within the scraped corpus.
    {
      JobID: 'a', sourceSite: 'lever', DescriptionCleaned: '',
      autoTags: { techStack: [], roleCategory: 'Data' }, SalaryMax: 50,
    },
    // A native employer posting: no sourceSite, must be excluded entirely.
    { title: 'native posting', companyId: 'x' },
  ]);

  const corpus = await getCorpusQuality();
  assert.equal(corpus.totalJobs, 4);        // the native posting is not counted
  assert.equal(corpus.cleanedCount, 2);     // an empty string does not count as cleaned
  assert.equal(corpus.taggedCount, 2);      // 'Other' with an empty stack is untagged
  assert.equal(corpus.salaryCount, 2);
  assert.equal(corpus.pctCleaned, 50);
  assert.equal(corpus.duplicateJobIds, 1);  // JobID 'a' appears twice
  await dropCollections('jobs');
});

test('getSiteSummaries and listRecentRuns read what the scraper recorded', async () => {
  await dropCollections('scrape_runs');
  await ensureScrapeRunIndexes();
  const base = Date.now();
  await recordScrapeRun({
    runId: 'p1', siteName: 'ashby', startedAt: new Date(base - 5000),
    jobsFetched: 40, newJobs: 100, scrapedSuccessfully: true,
  });
  await recordScrapeRun({
    runId: 'p1', siteName: 'lever', startedAt: new Date(base - 5000),
    scrapedSuccessfully: false, errorMessage: 'boom',
  });
  await recordScrapeRun({
    runId: 'p2', siteName: 'ashby', startedAt: new Date(base - 1000),
    jobsFetched: 42, newJobs: 20, scrapedSuccessfully: true,
  });

  const sites = await getSiteSummaries();
  assert.deepEqual(sites.map((site) => site.siteName), ['ashby', 'lever']);
  assert.equal(sites[0].latestNewJobs, 20);
  assert.equal(sites[0].avgNewJobs, 60);
  assert.equal(sites[1].lastRunFailed, true);
  assert.equal(sites[1].errorMessage, 'boom');

  assert.equal((await listRecentRuns({ siteName: 'ashby' })).length, 2);
  assert.equal((await listRecentRuns({ limit: 1 }))[0].siteName, 'ashby');
  await dropCollections('scrape_runs');
});
