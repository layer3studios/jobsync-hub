// FILE: src/api/admin/admin-analytics-routes.js
// Admin analytics endpoints. Mounted at /api/admin/analytics behind requireSeeker +
// requireAdmin (server.js). Each route bundles several named PostHog queries so a
// dashboard load hits ≤6 endpoints, not 25. The personal API key never appears in a
// response — it lives only inside the injected service. Returns 503 when analytics is
// not configured (POSTHOG_PERSONAL_API_KEY absent).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { createAnalyticsService } from '../../services/admin/analytics-service.js';
import { FUNNEL_STAGES } from '../../services/admin/analytics-queries.js';
import {
  pct, cohortRows, LOW_SAMPLE_THRESHOLD,
} from '../../services/admin/analytics-retention-queries.js';
import { getAssignmentStats } from '../../services/admin/assignment-analytics-service.js';
import {
  POSTHOG_HOST, POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY, ANALYTICS_CACHE_TTL_MS,
} from '../../env.js';

const SHORTCUTS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
let hasWarnedMissing = false;

// Build the singleton service from env, or null when the key is missing (D6).
function buildServiceFromEnv() {
  if (!POSTHOG_PERSONAL_API_KEY) {
    if (!hasWarnedMissing) {
      hasWarnedMissing = true;
      console.warn('[analytics] POSTHOG_PERSONAL_API_KEY missing — admin analytics disabled');
    }
    return null;
  }
  return createAnalyticsService({
    posthogHost: POSTHOG_HOST,
    projectId: POSTHOG_PROJECT_ID,
    personalApiKey: POSTHOG_PERSONAL_API_KEY,
    cacheTtlMs: ANALYTICS_CACHE_TTL_MS,
  });
}

// '24h' | '7d' | '30d' → a computed ISO; an ISO string is passed through; anything else
// is a 400 (D1). Omitted defaults to 7d.
function resolveSince(raw) {
  if (!raw) return new Date(Date.now() - SHORTCUTS['7d']).toISOString();
  if (SHORTCUTS[raw]) return new Date(Date.now() - SHORTCUTS[raw]).toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new HttpError(400, 'Invalid since parameter', 'INVALID_SINCE');
  return new Date(parsed).toISOString();
}

const scalar = (rows) => Number(rows?.[0]?.[0] ?? 0);
const series = (rows) => (rows ?? []).map(([day, value]) => ({ day: String(day), count: Number(value) }));
const buckets = (rows, key) => (rows ?? []).map(([bucket, value]) => ({ [key]: String(bucket), count: Number(value) }));
const funnelRows = (rows, name) => {
  const row = rows?.[0] ?? [];
  return FUNNEL_STAGES[name].map((stage, index) => ({ stage, count: Number(row[index] ?? 0) }));
};

export function createAdminAnalyticsRouter(options = {}) {
  const service = Object.prototype.hasOwnProperty.call(options, 'service')
    ? options.service
    : buildServiceFromEnv();

  const router = Router();

  // Guards every handler: 503 when analytics is not configured, and resolves `since`.
  const withService = (names, shape) => asyncHandler(async (req, res) => {
    if (!service) throw new HttpError(503, 'Admin analytics is not configured.', 'ANALYTICS_DISABLED');
    const since = resolveSince(req.query.since);
    const { results, cachedAt } = await service.runMany(names, since);
    res.json({ result: shape(results), cachedAt, since });
  });

  router.get('/volume', withService(
    ['visitors_total', 'visitors_by_day', 'pageviews_total', 'pageviews_by_day'],
    (r) => ({
      visitorsTotal: scalar(r.visitors_total),
      visitorsByDay: series(r.visitors_by_day),
      pageviewsTotal: scalar(r.pageviews_total),
      pageviewsByDay: series(r.pageviews_by_day),
    }),
  ));

  router.get('/seeker', withService(
    ['seeker_signups', 'seeker_logins', 'jobs_list_views', 'job_detail_views',
      'apply_started', 'apply_submitted', 'apply_success_viewed', 'seeker_conversion_funnel'],
    (r) => ({
      signups: scalar(r.seeker_signups),
      logins: scalar(r.seeker_logins),
      jobsListViews: scalar(r.jobs_list_views),
      jobDetailViews: scalar(r.job_detail_views),
      applyStarted: scalar(r.apply_started),
      applySubmitted: scalar(r.apply_submitted),
      applySuccessViewed: scalar(r.apply_success_viewed),
      funnel: funnelRows(r.seeker_conversion_funnel, 'seeker_conversion_funnel'),
    }),
  ));

  router.get('/employer', withService(
    ['employer_signups', 'employer_logins', 'onboarding_started', 'onboarding_completed',
      'postings_created', 'postings_published', 'employer_conversion_funnel'],
    (r) => ({
      signups: scalar(r.employer_signups),
      logins: scalar(r.employer_logins),
      onboardingStarted: scalar(r.onboarding_started),
      onboardingCompleted: scalar(r.onboarding_completed),
      postingsCreated: scalar(r.postings_created),
      postingsPublished: scalar(r.postings_published),
      funnel: funnelRows(r.employer_conversion_funnel, 'employer_conversion_funnel'),
    }),
  ));

  router.get('/retention', withService(
    ['dau_mau', 'weekly_cohort_returns', 'retention_signups_by_week'],
    (r) => {
      const [dau = 0, wau = 0, mau = 0] = (r.dau_mau?.[0] ?? []).map(Number);
      return {
        stickiness: { dau, wau, mau, dauMauPct: pct(dau, mau) },
        cohorts: cohortRows(r.weekly_cohort_returns, r.retention_signups_by_week),
        // Stated in the payload, not just the docs: the UI labels the column from it.
        w1IsApproximate: true,
        w1Method: 'still active 7+ days after first seen',
        lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
      };
    },
  ));

  router.get('/engagement', withService(
    ['applicants_viewed', 'applicants_moved_stage', 'applicants_archived', 'notes_added'],
    (r) => ({
      applicantsViewed: scalar(r.applicants_viewed),
      applicantsMovedStage: scalar(r.applicants_moved_stage),
      applicantsArchived: scalar(r.applicants_archived),
      notesAdded: scalar(r.notes_added),
    }),
  ));

  router.get('/team', withService(
    ['invites_sent', 'invites_accepted'],
    (r) => ({ invitesSent: scalar(r.invites_sent), invitesAccepted: scalar(r.invites_accepted) }),
  ));

  router.get('/traffic', withService(
    ['traffic_by_referrer', 'traffic_by_device'],
    (r) => ({ byReferrer: buckets(r.traffic_by_referrer, 'bucket'), byDevice: buckets(r.traffic_by_device, 'device') }),
  ));

  // ── Take-home assignments: TWO endpoints, TWO failure modes, one page ──────
  //
  // /assignments reads Mongo and has no PostHog dependency, so it answers even when
  // POSTHOG_PERSONAL_API_KEY is absent — deliberately NOT wrapped in withService.
  // /assignments/funnel is HogQL and 503s like every other analytics route. The
  // admin page renders the first block regardless and degrades only the second.
  const assignmentsStatsService = options.assignmentStatsService ?? getAssignmentStats;

  router.get('/assignments', asyncHandler(async (_req, res) => {
    const result = await assignmentsStatsService();
    res.json({ result });
  }));

  router.get('/assignments/funnel', withService(
    ['assignment_abandonment', 'assignments_created', 'assignment_reviews_submitted',
      'assignment_review_conflicts'],
    (r) => {
      const [assignmentViewed = 0, assignmentSubmitted = 0, plainViewed = 0, plainSubmitted = 0] =
        (r.assignment_abandonment?.[0] ?? []).map(Number);
      // RAW COUNTS ALONGSIDE THE RATIO, always. A 0.40 completion rate off 5 views
      // is noise; off 5,000 it is the feature's verdict. Handing back only the ratio
      // hides which one an admin is looking at. A null ratio means "no sample",
      // which is honest in a way that 0 is not.
      const ratio = (submitted, viewed) => (viewed > 0 ? Number((submitted / viewed).toFixed(4)) : null);
      return {
        assignment: {
          viewed: assignmentViewed,
          submitted: assignmentSubmitted,
          completionRatio: ratio(assignmentSubmitted, assignmentViewed),
        },
        plain: {
          viewed: plainViewed,
          submitted: plainSubmitted,
          completionRatio: ratio(plainSubmitted, plainViewed),
        },
        assignmentsCreated: scalar(r.assignments_created),
        reviewsSubmitted: scalar(r.assignment_reviews_submitted),
        reviewConflicts: scalar(r.assignment_review_conflicts),
      };
    },
  ));

  return router;
}

export default createAdminAnalyticsRouter;
