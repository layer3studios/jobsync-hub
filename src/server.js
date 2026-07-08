// FILE: src/server.js
// Application entry. Wires middleware, routes, and scheduled tasks.

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';

import { PORT, FRONTEND_URL, RUN_SCRAPER_ON_START } from './env.js';
import { connectToDb, closeDb } from './Db/connection.js';
import { ensureUserIndexes } from './models/seeker/index.js';
import { ensureJobIndexes } from './models/shared/job-model.js';
import {
  ensureEmployerUserIndexes,
  ensureEmployerAccessIndexes,
  ensureCompanyIndexes,
  ensureStageIndexes,
  ensureArchiveReasonIndexes,
  ensurePostingIndexes,
} from './models/employer/index.js';

import {
  ensureConsentIndexes,
  ensureAuditLogIndexes,
  ensureRightsRequestIndexes,
} from './models/dpdp/index.js';

import { initGemma } from './gemma/index.js';
import { GEMMA_API_KEYS } from './env.js';

import { runScraper } from './tasks/runScraper.js';

import authRouter from './api/seeker/seeker-auth-routes.js';
import meRouter from './api/seeker/seeker-me-routes.js';
import { jobsApiRouter } from './api/seeker/seeker-jobs-routes.js';
import usersRouter from './api/seeker/seeker-users-routes.js';
import adminRouter from './api/admin/admin-routes.js';
import newsRouter from './api/seeker/news-routes.js';
import { createEmployerAuthRouter } from './api/employer/employer-auth-routes.js';
import employerCompanyRouter from './api/employer/employer-company-routes.js';
import employerPostingsRouter from './api/employer/employer-postings-routes.js';
import employerApplicantRouter from './api/employer/employer-applicant-routes.js';
import employerStagesRouter from './api/employer/employer-stages-routes.js';
import employerArchiveReasonsRouter from './api/employer/employer-archive-reasons-routes.js';
import resumeDownloadRouter from './api/public/resume-download-route.js';
import dpdpRouter from './api/dpdp/dpdp-routes.js';
import seekerResumeRouter from './api/seeker/seeker-resume-routes.js';
import seekerProfileRouter from './api/seeker/seeker-profile-routes.js';
import seekerMarketRouter from './api/seeker/seeker-market-routes.js';
import publicApplyRouter from './api/public/public-apply-routes.js';
import {
  ensureContactIndexes, ensureApplicationIndexes,
  ensureStageChangeIndexes, ensureResumeFileIndexes, ensureResumeScoreIndexes,
} from './models/public/index.js';
import { ensureResumeDirectory } from './services/public/resume-storage-service.js';
import { ensureResumeParseJobIndexes } from './models/seeker/resume-parse-job-model.js';
import { ensureTmpDirectory } from './services/seeker/resume-tmp-storage.js';
import { startResumeParseWorker } from './services/seeker/resume-parse-worker.js';
import { ensureResumeScoreJobIndexes } from './models/public/resume-score-job-model.js';
import { startScoreWorker } from './services/public/resume-score-worker.js';

import { requireSeeker } from './middleware/require-seeker-middleware.js';
import { requireConsentForPurpose } from './middleware/require-consent-middleware.js';
import { requireEmployer } from './middleware/require-employer-middleware.js';
import { requireEmployerCompany } from './middleware/require-employer-company-middleware.js';
import { notFound, errorHandler } from './middleware/error-handler-middleware.js';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ─── Health ───────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('Job Scraper Backend running.'));

// ─── Routes ───────────────────────────────────────────────────────
app.use('/api/seeker/auth', authRouter);
app.use('/api/seeker/me', requireSeeker, meRouter);
app.use('/api/seeker/jobs', jobsApiRouter);
app.use('/api/seeker/users', usersRouter); // legacy 410 wildcard
app.use('/api/admin', adminRouter);
app.use('/api/seeker/news', newsRouter);
app.use('/api/seeker/resume', requireSeeker, requireConsentForPurpose('resume_parsing'), seekerResumeRouter);
app.use('/api/seeker/profile', requireSeeker, seekerProfileRouter);
app.use('/api/seeker/market', requireSeeker, seekerMarketRouter);
app.use('/api/employer/auth', createEmployerAuthRouter());
app.use('/api/employer/company', requireEmployer, employerCompanyRouter);
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerPostingsRouter);
app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerApplicantRouter);
app.use('/api/employer/stages', requireEmployer, requireEmployerCompany, employerStagesRouter);
app.use('/api/employer/archive-reasons', requireEmployer, requireEmployerCompany, employerArchiveReasonsRouter);
app.use('/api/dpdp', dpdpRouter); // per-route guards (D9) — /notice-version is public
app.use('/api/public/resume-download', resumeDownloadRouter); // signed-token PDF stream (before the apply catch-all)
app.use('/api/public', publicApplyRouter); // unauthenticated candidate apply pages

// ─── 404 + central error handler (must be last) ───────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  try {
    await connectToDb();
    await ensureUserIndexes();
    await ensureJobIndexes();
    await ensureEmployerUserIndexes();
    await ensureEmployerAccessIndexes();
    await ensureCompanyIndexes();
    await ensureStageIndexes();
    await ensureArchiveReasonIndexes();
    await ensurePostingIndexes();
    await ensureConsentIndexes();
    await ensureAuditLogIndexes();
    await ensureRightsRequestIndexes();
    await ensureContactIndexes();
    await ensureApplicationIndexes();
    await ensureStageChangeIndexes();
    await ensureResumeFileIndexes();
    await ensureResumeScoreIndexes();
    await ensureResumeParseJobIndexes();
    ensureResumeDirectory();
    ensureTmpDirectory();

    // Gemma JD extraction is optional — the server boots fine without keys.
    if (GEMMA_API_KEYS) {
      const liveKeys = initGemma();
      console.log(`[gemma] Initialized with ${liveKeys} keys.`);
    } else {
      console.log('[gemma] No API keys configured — extraction disabled.');
    }

    // Async resume-parse queue: recover stuck jobs, sweep temp files, start polling.
    await startResumeParseWorker();
    console.log('[queue] resume parse worker started');

    // Persistent applicant-scoring queue (Q1): recover stuck jobs, spawn N slots.
    await ensureResumeScoreJobIndexes();
    await startScoreWorker();

    console.log(`[server] listening on http://localhost:${PORT}`);

    // Daily scrape at 06:00 server time.
    cron.schedule('0 6 * * *', () => {
      console.log('[cron] daily scrape');
      runScraper();
    });
    console.log('[cron] scheduled');

    if (RUN_SCRAPER_ON_START) {
      console.log('[boot] RUN_SCRAPER_ON_START is true — running initial scrape');
      runScraper();
    }
  } catch (err) {
    console.error('[server] failed to start', err);
    process.exit(1);
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[server] ${signal} — shutting down`);
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  // hard-kill if close hangs
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
