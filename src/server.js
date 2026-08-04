// FILE: src/server.js
// Application entry. Wires middleware, routes, and scheduled tasks.

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';

import { PORT, FRONTEND_URL, RUN_SCRAPER_ON_START, SYNC_ENABLED } from './env.js';
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
  ensureCompanyMemberIndexes,
  ensureCompanyInviteIndexes,
  ensureAssignmentIndexes,
  ensureSavedViewIndexes,
} from './models/employer/index.js';

import {
  ensureConsentIndexes,
  ensureAuditLogIndexes,
  ensureRightsRequestIndexes,
} from './models/dpdp/index.js';

import { ensureAdminUserIndexes } from './models/admin/index.js';

import { ensureInterviewIndexes, ensureInterviewReminderJobIndexes, ensureInterviewTimeIndexes } from './models/interview/index.js';
import employerInterviewTimesRouter from './api/employer/employer-interview-times-routes.js';
import { startInterviewReminderWorker } from './services/interview/interview-reminder-worker.js';

import { initGemma } from './gemma/index.js';

import { runScraper } from './tasks/runScraper.js';

import authRouter from './api/seeker/seeker-auth-routes.js';
import meRouter from './api/seeker/seeker-me-routes.js';
import { jobsApiRouter } from './api/seeker/seeker-jobs-routes.js';
import usersRouter from './api/seeker/seeker-users-routes.js';
import adminRouter from './api/admin/admin-routes.js';
import { createAdminAuthRouter } from './api/admin/admin-auth-routes.js';
import { createAdminAnalyticsRouter } from './api/admin/admin-analytics-routes.js';
import adminTeamRouter from './api/admin/admin-team-routes.js';
import { createAdminAiUsageRouter } from './api/admin/admin-ai-usage-routes.js';
import { ensureUsageStatsIndexes } from './gemma/usage-stats.js';
import newsRouter from './api/seeker/news-routes.js';
import { createEmployerAuthRouter } from './api/employer/employer-auth-routes.js';
import employerCompanyRouter from './api/employer/employer-company-routes.js';
import employerPostingsRouter from './api/employer/employer-postings-routes.js';
import employerAssignmentsRouter from './api/employer/employer-assignments-routes.js';
import employerAssignmentReviewsRouter from './api/employer/employer-assignment-reviews-routes.js';
import employerApplicantRouter from './api/employer/employer-applicant-routes.js';
import employerSavedViewsRouter from './api/employer/employer-saved-views-routes.js';
import employerStagesRouter from './api/employer/employer-stages-routes.js';
import employerArchiveReasonsRouter from './api/employer/employer-archive-reasons-routes.js';
import employerTeamRouter, { acceptRouter as employerInviteAcceptRouter } from './api/employer/employer-team-routes.js';
import employerInterviewRouter from './api/employer/employer-interview-routes.js';
import employerDashboardRouter from './api/employer/employer-dashboard-routes.js';
import publicInterviewRouter from './api/public/public-interview-routes.js';
import publicInviteRouter from './api/public/public-invite-routes.js';
import resumeDownloadRouter from './api/public/resume-download-route.js';
import assignmentStagingRouter from './api/public/assignment-staging-routes.js';
import assignmentDownloadRouter from './api/public/assignment-download-route.js';
import {
  ensureAssignmentDirectories, sweepOldStagedFiles,
} from './services/public/assignment-storage-service.js';
import {
  reconcileAssignmentFiles, collectReferencedStagingPaths,
} from './services/public/assignment-file-reconciler.js';
import dpdpRouter from './api/dpdp/dpdp-routes.js';
import seekerResumeRouter from './api/seeker/seeker-resume-routes.js';
import seekerProfileRouter from './api/seeker/seeker-profile-routes.js';
import seekerMarketRouter from './api/seeker/seeker-market-routes.js';
import publicApplyRouter from './api/public/public-apply-routes.js';
import {
  ensureContactIndexes, ensureApplicationIndexes,
  ensureStageChangeIndexes, ensureResumeFileIndexes, ensureResumeScoreIndexes,
  ensureApplicantNoteIndexes,
  ensureAssignmentSubmissionIndexes, ensureAssignmentReviewIndexes,
} from './models/public/index.js';
import { ensureResumeDirectory } from './services/public/resume-storage-service.js';
import { ensureResumeParseJobIndexes } from './models/seeker/resume-parse-job-model.js';
import { ensureTmpDirectory } from './services/seeker/resume-tmp-storage.js';
import { startResumeParseWorker } from './services/seeker/resume-parse-worker.js';
import { ensureResumeScoreJobIndexes } from './models/public/resume-score-job-model.js';
import { startScoreWorker } from './services/public/resume-score-worker.js';

import { requireSeeker } from './middleware/require-seeker-middleware.js';
import { requireAdmin } from './middleware/require-admin-middleware.js';
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
// Admin auth (jm_admin_token). MUST mount before /api/admin so /api/admin/auth/*
// is not gated by requireAdmin (a user with no admin session must be able to log in).
app.use('/api/admin/auth', createAdminAuthRouter());
app.use('/api/admin/team', requireAdmin, adminTeamRouter);
// AI spend dashboard. Mounted before /api/admin so the generic admin router
// never shadows it.
app.use('/api/admin/ai-usage', requireAdmin, createAdminAiUsageRouter());
app.use('/api/admin', adminRouter);
// Admin analytics: jm_admin_token via new require-admin-middleware (D5 — standalone,
// no seeker chain). Kept mounted separately (not under adminRouter) to preserve
// master's route file boundary.
app.use('/api/admin/analytics', requireAdmin, createAdminAnalyticsRouter());
app.use('/api/seeker/news', newsRouter);
app.use('/api/seeker/resume', requireSeeker, requireConsentForPurpose('resume_parsing'), seekerResumeRouter);
app.use('/api/seeker/profile', requireSeeker, seekerProfileRouter);
app.use('/api/seeker/market', requireSeeker, seekerMarketRouter);
app.use('/api/employer/auth', createEmployerAuthRouter());
app.use('/api/employer/company', requireEmployer, employerCompanyRouter);
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerPostingsRouter);
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerSavedViewsRouter);
app.use('/api/employer/assignments', requireEmployer, requireEmployerCompany, employerAssignmentsRouter);
app.use('/api/employer/assignment-reviews', requireEmployer, requireEmployerCompany, employerAssignmentReviewsRouter);
app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerApplicantRouter);
app.use('/api/employer/stages', requireEmployer, requireEmployerCompany, employerStagesRouter);
app.use('/api/employer/archive-reasons', requireEmployer, requireEmployerCompany, employerArchiveReasonsRouter);
// Accept mounts BEFORE the company-scoped team router: the invitee may have no
// company yet, so it uses requireEmployer only — NOT requireEmployerCompany (D2/R6).
app.use('/api/employer/team/invites/accept', requireEmployer, employerInviteAcceptRouter);
app.use('/api/employer/team', requireEmployer, requireEmployerCompany, employerTeamRouter);
app.use('/api/employer/dashboard', requireEmployer, requireEmployerCompany, employerDashboardRouter);
app.use('/api/employer', requireEmployer, requireEmployerCompany, employerInterviewRouter);
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerInterviewTimesRouter);
app.use('/api/dpdp', dpdpRouter); // per-route guards (D9) — /notice-version is public
app.use('/api/public/resume-download', resumeDownloadRouter); // signed-token PDF stream (before the apply catch-all)
app.use('/api/public/invites', publicInviteRouter); // unauthenticated invite preview (before the apply catch-all)
app.use('/api/public/assignment-files', assignmentStagingRouter); // staging upload (before the apply catch-all)
app.use('/api/public/assignment-download', assignmentDownloadRouter); // signed-token file stream (before the apply catch-all)
app.use('/api/public', publicInterviewRouter); // unauthenticated interview booking (before the apply catch-all)
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
    await ensureAdminUserIndexes();
    await ensureUsageStatsIndexes();
    await ensureEmployerAccessIndexes();
    await ensureCompanyIndexes();
    await ensureStageIndexes();
    await ensureArchiveReasonIndexes();
    await ensurePostingIndexes();
    await ensureCompanyMemberIndexes();
    await ensureCompanyInviteIndexes();
    await ensureSavedViewIndexes();
    await ensureConsentIndexes();
    await ensureAuditLogIndexes();
    await ensureRightsRequestIndexes();
    await ensureContactIndexes();
    await ensureApplicationIndexes();
    await ensureStageChangeIndexes();
    await ensureApplicantNoteIndexes();
    await ensureAssignmentIndexes();
    await ensureAssignmentSubmissionIndexes();
    await ensureAssignmentReviewIndexes();
    await ensureResumeFileIndexes();
    await ensureResumeScoreIndexes();
    await ensureResumeParseJobIndexes();
    await ensureInterviewIndexes();
    await ensureInterviewTimeIndexes();
    ensureResumeDirectory();
    ensureTmpDirectory();
    ensureAssignmentDirectories();
    // Recover files whose submission committed but whose rename never ran (crash
    // between the two halves of that dual write).
    const { promoted, missing } = await reconcileAssignmentFiles();
    console.log(`[assignments] reconciled ${promoted} files, ${missing} missing`);
    const swept = sweepOldStagedFiles({ referenced: await collectReferencedStagingPaths() });
    console.log(`[assignments] swept ${swept} stale staged files`);
    // Staged uploads that were never submitted are reclaimed daily; a single boot
    // sweep would leave a long-lived process accumulating them indefinitely. The
    // referenced set is recomputed each time — a file committed since the last
    // sweep must never be treated as an orphan just because it is old.
    setInterval(() => {
      collectReferencedStagingPaths()
        .then((referenced) => sweepOldStagedFiles({ referenced }))
        .catch((err) => console.warn('[assignments] sweep failed:', err.message));
    }, 24 * 60 * 60 * 1000).unref();

    // Gemma is optional — the server boots fine without keys. initGemma() builds
    // both pools and logs their status itself, including the no-keys case (C10).
    initGemma();

    // Async resume-parse queue: recover stuck jobs, sweep temp files, start polling.
    await startResumeParseWorker();
    console.log('[queue] resume parse worker started');

    // Persistent applicant-scoring queue (Q1): recover stuck jobs, spawn N slots.
    await ensureResumeScoreJobIndexes();
    await startScoreWorker();

    // 24h interview reminders (same in-process pattern as the score worker).
    await ensureInterviewReminderJobIndexes();
    startInterviewReminderWorker();

    console.log(`[server] listening on http://localhost:${PORT}`);

    // Daily scrape at 06:00 server time — gated on SYNC_ENABLED so .env can disable it.
    if (SYNC_ENABLED) {
      cron.schedule('0 6 * * *', () => {
        console.log('[cron] daily scrape');
        runScraper();
      });
      console.log('[cron] scheduled');
    } else {
      console.log('[cron] scrape schedule DISABLED (SYNC_ENABLED=false)');
    }

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