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
  ensureCandidateTagIndexes,
} from './models/employer/index.js';

import {
  ensureConsentIndexes,
  ensureAuditLogIndexes,
  ensureRightsRequestIndexes,
  ensureDataExportRequestIndexes,
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
import { createScraperHealthRouter } from './api/admin/scraper-health-routes.js';
import { createQueueMonitorRouter } from './api/admin/queue-monitor-routes.js';
import { createAuditLogRouter } from './api/admin/audit-log-routes.js';
import { createFeatureFlagsRouter } from './api/admin/feature-flags-routes.js';
import { createJobBrowserRouter } from './api/admin/job-browser-routes.js';
import { createEmailLogRouter } from './api/admin/email-log-routes.js';
import { createAlertSettingsRouter } from './api/admin/alert-settings-routes.js';
import { createResendWebhookRouter } from './api/public/resend-webhook-route.js';
import { ensureEmailEventIndexes } from './models/admin/email-event-model.js';
import { checkAndAlert } from './services/admin/ai-alert-service.js';
import { sendWeeklyDigest } from './services/admin/weekly-digest-service.js';
import { getAlertSettings } from './models/admin/alert-settings-model.js';
import { isFeatureEnabled } from './models/admin/feature-flags-model.js';
import { createCompanyHealthRouter } from './api/admin/company-health-routes.js';
import { createMissionControlRouter } from './api/admin/mission-control-routes.js';
import { ensureScrapeRunIndexes } from './models/admin/index.js';
import newsRouter from './api/seeker/news-routes.js';
import { createEmployerAuthRouter } from './api/employer/employer-auth-routes.js';
import employerCompanyRouter from './api/employer/employer-company-routes.js';
import employerPostingsRouter from './api/employer/employer-postings-routes.js';
import employerAssignmentsRouter from './api/employer/employer-assignments-routes.js';
import employerAssignmentReviewsRouter from './api/employer/employer-assignment-reviews-routes.js';
import employerMeRouter from './api/employer/employer-me-routes.js';
import employerContactRouter from './api/employer/employer-contact-routes.js';
import employerApplicantRouter from './api/employer/employer-applicant-routes.js';
import employerCandidateExportRouter from './api/employer/employer-candidate-export-routes.js';
import employerSavedViewsRouter from './api/employer/employer-saved-views-routes.js';
import employerStagesRouter from './api/employer/employer-stages-routes.js';
import employerArchiveReasonsRouter from './api/employer/employer-archive-reasons-routes.js';
import employerTeamRouter, { acceptRouter as employerInviteAcceptRouter } from './api/employer/employer-team-routes.js';
import employerInterviewRouter from './api/employer/employer-interview-routes.js';
import employerDashboardRouter from './api/employer/employer-dashboard-routes.js';
import employerTagRouter from './api/employer/employer-tag-routes.js';
import employerActivityRouter from './api/employer/employer-activity-routes.js';
import employerExportRouter from './api/employer/employer-export-routes.js';
import employerImportRouter from './api/employer/employer-import-routes.js';
import publicInterviewRouter from './api/public/public-interview-routes.js';
import publicInviteRouter from './api/public/public-invite-routes.js';
import publicDpdpExportRouter from './api/public/public-dpdp-export-routes.js';
import employerAvatarRouter from './api/public/employer-avatar-route.js';
import resumeDownloadRouter from './api/public/resume-download-route.js';
import companyLogoRouter from './api/public/company-logo-route.js';
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
import { ensureLogoDirectory } from './services/employer/logo-storage-service.js';
import { ensureAvatarDirectory } from './services/employer/avatar-storage-service.js';
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
// Svix signs the EXACT request bytes, so this one path takes the raw buffer.
// It MUST precede the global express.json below: once json() has parsed the
// body, the original bytes are unrecoverable and no signature can verify.
app.use('/api/public/webhooks/resend', express.raw({ type: '*/*', limit: '1mb' }));
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
// Scraper health. Same reason as ai-usage: mounted before the generic admin
// router so it is never shadowed.
app.use('/api/admin/scraper-health', requireAdmin, createScraperHealthRouter());
// Queue monitor. Same reason as ai-usage: mounted before the generic admin
// router so it is never shadowed.
app.use('/api/admin/queues', requireAdmin, createQueueMonitorRouter());
// Company health + mission control. Same reason as ai-usage: mounted before
// the generic admin router so neither is ever shadowed.
app.use('/api/admin/companies-health', requireAdmin, createCompanyHealthRouter());
app.use('/api/admin/overview', requireAdmin, createMissionControlRouter());
app.use('/api/admin/audit-log', requireAdmin, createAuditLogRouter());
app.use('/api/admin/feature-flags', requireAdmin, createFeatureFlagsRouter());
app.use('/api/admin/jobs', requireAdmin, createJobBrowserRouter());
app.use('/api/admin/email-log', requireAdmin, createEmailLogRouter());
app.use('/api/admin/alerts', requireAdmin, createAlertSettingsRouter());
app.use('/api/public/webhooks/resend', createResendWebhookRouter());
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
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerExportRouter);
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerImportRouter);
app.use('/api/employer/assignments', requireEmployer, requireEmployerCompany, employerAssignmentsRouter);
app.use('/api/employer/assignment-reviews', requireEmployer, requireEmployerCompany, employerAssignmentReviewsRouter);
// Export mounts BEFORE the main applicant router only for tidiness — the paths do
// not overlap (/:applicationId/export exists on neither the other router nor a
// static path it could shadow).
// Personal settings. requireEmployer ONLY: these are the user's own fields, and a
// teammate who has not finished onboarding still has a timezone.
app.use('/api/employer/me', requireEmployer, employerMeRouter);
app.use('/api/employer/contacts', requireEmployer, requireEmployerCompany, employerContactRouter);
app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerCandidateExportRouter);
app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerApplicantRouter);
app.use('/api/employer/stages', requireEmployer, requireEmployerCompany, employerStagesRouter);
app.use('/api/employer/archive-reasons', requireEmployer, requireEmployerCompany, employerArchiveReasonsRouter);
// Accept mounts BEFORE the company-scoped team router: the invitee may have no
// company yet, so it uses requireEmployer only — NOT requireEmployerCompany (D2/R6).
app.use('/api/employer/team/invites/accept', requireEmployer, employerInviteAcceptRouter);
app.use('/api/employer/team', requireEmployer, requireEmployerCompany, employerTeamRouter);
app.use('/api/employer/dashboard', requireEmployer, requireEmployerCompany, employerDashboardRouter);
// Both declare their own full paths (/tags, /applicants/:id/tags, /activity), so they
// mount on the bare /api/employer prefix like the interview router below.
app.use('/api/employer', requireEmployer, requireEmployerCompany, employerTagRouter);
app.use('/api/employer', requireEmployer, requireEmployerCompany, employerActivityRouter);
app.use('/api/employer', requireEmployer, requireEmployerCompany, employerInterviewRouter);
app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerInterviewTimesRouter);
app.use('/api/dpdp', dpdpRouter); // per-route guards (D9) — /notice-version is public
app.use('/api/public/resume-download', resumeDownloadRouter); // signed-token PDF stream (before the apply catch-all)
app.use('/api/public/company-logo', companyLogoRouter); // unauthenticated careers-page logo (before the apply catch-all)
app.use('/api/public/avatar', employerAvatarRouter); // unauthenticated interviewer photo (before the apply catch-all)
app.use('/api/public/invites', publicInviteRouter); // unauthenticated invite preview (before the apply catch-all)
// DPDP right of access. Unauthenticated by necessity — the emailed one-time token
// is the credential. Mounted before the apply catch-all.
app.use('/api/public/dpdp', publicDpdpExportRouter);
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
    await ensureScrapeRunIndexes();
    await ensureEmailEventIndexes();
    await ensureEmployerAccessIndexes();
    await ensureCompanyIndexes();
    await ensureStageIndexes();
    await ensureArchiveReasonIndexes();
    await ensurePostingIndexes();
    await ensureCompanyMemberIndexes();
    await ensureCompanyInviteIndexes();
    await ensureSavedViewIndexes();
    await ensureCandidateTagIndexes();
    await ensureConsentIndexes();
    await ensureAuditLogIndexes();
    await ensureRightsRequestIndexes();
    await ensureDataExportRequestIndexes();
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
    ensureLogoDirectory();
    ensureAvatarDirectory();
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
      cron.schedule('0 6 * * *', async () => {
        // SYNC_ENABLED (above) decides whether the job is ever scheduled; the
        // flag is the runtime pause an admin can toggle without a redeploy.
        // isFeatureEnabled fails open, so a DB problem still runs the scrape.
        if (!(await isFeatureEnabled('scraperCronEnabled'))) {
          console.log('[cron] daily scrape SKIPPED (scraperCronEnabled=false)');
          return;
        }
        console.log('[cron] daily scrape');
        runScraper();
      });
      console.log('[cron] scheduled');
    } else {
      console.log('[cron] scrape schedule DISABLED (SYNC_ENABLED=false)');
    }

    // AI budget alerts every 30 minutes, and the digest on Monday 08:00.
    // Both no-op silently unless alertsEnabled is on, so an unconfigured
    // install never emails anyone. checkAndAlert re-checks the flag itself.
    cron.schedule('*/30 * * * *', () => { void checkAndAlert(); });
    cron.schedule('0 8 * * 1', async () => {
      const settings = await getAlertSettings().catch(() => null);
      if (!settings?.alertsEnabled) return;
      console.log('[cron] weekly admin digest');
      void sendWeeklyDigest();
    });
    console.log('[cron] alert checks + weekly digest scheduled');

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