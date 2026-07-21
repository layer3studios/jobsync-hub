// FILE: src/services/admin/analytics-queries.js
// Named HogQL query builders for the admin analytics dashboard. Every builder takes a
// validated ISO `since` string and returns a SELECT string for the PostHog Query API.
// Queries are read-only, single-table (`events`), and simple (count / distinct / group
// by) — no JOINs (R2). `since` is always a server-validated ISO timestamp (the route
// layer rejects anything else), so inlining it into toDateTime(...) is safe from
// injection. Event names mirror the 41 frontend custom events (chore/posthog-analytics).

const PAGEVIEW = '$pageview';

// since → a HogQL datetime literal. `s` is a validated ISO string (route layer).
const at = (s) => `toDateTime('${s}')`;

// count() of one event since `s`.
const countEvent = (event, s) =>
  `SELECT count() FROM events WHERE event = '${event}' AND timestamp >= ${at(s)}`;

// A per-day time series of `agg` over $pageview since `s`.
const pageviewsPerDay = (agg, s) =>
  `SELECT toDate(timestamp) AS day, ${agg} AS value FROM events `
  + `WHERE event = '${PAGEVIEW}' AND timestamp >= ${at(s)} GROUP BY day ORDER BY day`;

// One-row funnel: a countIf() column per stage, in stage order (D2).
const funnel = (events, s) => {
  const columns = events.map((event) => `countIf(event = '${event}')`).join(', ');
  return `SELECT ${columns} FROM events WHERE timestamp >= ${at(s)}`;
};

// Referrer bucketed into a small fixed set (D3) — never the raw URL.
const referrerBuckets = (s) =>
  'SELECT multiIf('
  + "coalesce(properties.$referrer, '') = '', 'direct', "
  + "properties.$referrer ILIKE '%google%', 'google', "
  + "properties.$referrer ILIKE '%t.co%' OR properties.$referrer ILIKE '%twitter%' OR properties.$referrer ILIKE '%x.com%', 'twitter', "
  + "properties.$referrer ILIKE '%facebook%', 'facebook', "
  + "properties.$referrer ILIKE '%linkedin%', 'linkedin', "
  + "'other') AS bucket, count() AS value "
  + `FROM events WHERE event = '${PAGEVIEW}' AND timestamp >= ${at(s)} GROUP BY bucket ORDER BY value DESC`;

const deviceBuckets = (s) =>
  "SELECT coalesce(properties.$device_type, 'unknown') AS device, count() AS value "
  + `FROM events WHERE event = '${PAGEVIEW}' AND timestamp >= ${at(s)} GROUP BY device ORDER BY value DESC`;

// Ordered stage lists so the route layer can label a funnel's one-row result.
export const FUNNEL_STAGES = {
  seeker_conversion_funnel: ['jobs_list_viewed', 'job_viewed', 'apply_started', 'apply_submitted'],
  employer_conversion_funnel: [
    'employer_signup_completed', 'onboarding_started', 'onboarding_completed',
    'posting_form_opened', 'posting_created',
  ],
};

// name → (since) => HogQL string. The service looks queries up here by name.
export const QUERIES = {
  // Volume
  visitors_total: (s) => `SELECT count(DISTINCT person_id) FROM events WHERE event = '${PAGEVIEW}' AND timestamp >= ${at(s)}`,
  visitors_by_day: (s) => pageviewsPerDay('count(DISTINCT person_id)', s),
  pageviews_total: (s) => `SELECT count() FROM events WHERE event = '${PAGEVIEW}' AND timestamp >= ${at(s)}`,
  pageviews_by_day: (s) => pageviewsPerDay('count()', s),

  // Seeker funnel
  seeker_signups: (s) => countEvent('seeker_signup_completed', s),
  seeker_logins: (s) => countEvent('seeker_login_completed', s),
  jobs_list_views: (s) => countEvent('jobs_list_viewed', s),
  job_detail_views: (s) => countEvent('job_viewed', s),
  apply_started: (s) => countEvent('apply_started', s),
  apply_submitted: (s) => countEvent('apply_submitted', s),
  apply_success_viewed: (s) => countEvent('apply_success_viewed', s),
  seeker_conversion_funnel: (s) => funnel(FUNNEL_STAGES.seeker_conversion_funnel, s),

  // Employer funnel
  employer_signups: (s) => countEvent('employer_signup_completed', s),
  employer_logins: (s) => countEvent('employer_login_completed', s),
  onboarding_started: (s) => countEvent('onboarding_started', s),
  onboarding_completed: (s) => countEvent('onboarding_completed', s),
  postings_created: (s) => countEvent('posting_created', s),
  postings_published: (s) => countEvent('posting_published', s),
  employer_conversion_funnel: (s) => funnel(FUNNEL_STAGES.employer_conversion_funnel, s),

  // Employer engagement
  applicants_viewed: (s) => countEvent('applicant_viewed', s),
  applicants_moved_stage: (s) => countEvent('applicant_moved_stage', s),
  applicants_archived: (s) => countEvent('applicant_archived', s),
  notes_added: (s) => countEvent('note_added', s),

  // Team invites
  invites_sent: (s) => countEvent('invite_sent', s),
  invites_accepted: (s) => countEvent('invite_accepted', s),

  // Traffic sources
  traffic_by_referrer: (s) => referrerBuckets(s),
  traffic_by_device: (s) => deviceBuckets(s),
};
