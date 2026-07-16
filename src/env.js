// FILE: src/env.js
// Central env loader. Fails loudly when critical secrets are missing.

import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[env] Missing required env var: ${name}`);
  }
  return value || '';
}

// FIX: previously read process.env.GEMINI_API_KEY. Now reads the right var,
// with a one-time fallback so existing prod deployments don't break.
export const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '';

export const MONGO_URI = required('MONGO_URI');
export const GOOGLE_CLIENT_ID = required('GOOGLE_CLIENT_ID');
export const JWT_SECRET = required('JWT_SECRET');

// Employer auth — fully separate identity stack from the seeker JWT_SECRET.
// A leaked/forged seeker token must never authenticate against employer routes.
export const EMPLOYER_JWT_SECRET = required('EMPLOYER_JWT_SECRET');
export const EMPLOYER_COOKIE_NAME = 'jm_employer_token';
export const EMPLOYER_JWT_EXPIRY = '7d'; // matches seeker for consistency

// Secret for signing resume-download URLs (HMAC-SHA256). Production MUST set this
// explicitly; the EMPLOYER_JWT_SECRET fallback is a dev convenience only (both are
// server-side secrets), and the last literal keeps tests/boot working with neither.
export const RESUME_URL_SECRET = process.env.RESUME_URL_SECRET
  || process.env.EMPLOYER_JWT_SECRET
  || 'dev-resume-secret';

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';
export const PORT = parseInt(process.env.PORT, 10) || 3000;

export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Comma-separated list of admin email addresses. Used by requireAdmin middleware.
export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Whether to run the scraper once at startup. Default off in development.
export const RUN_SCRAPER_ON_START = process.env.RUN_SCRAPER_ON_START === 'true';

// Master switch for the daily scrape cron. Defaults true (backward compat) — anything
// other than the literal 'false' keeps the existing behavior. Set SYNC_ENABLED=false to
// stop the 6 AM scrape from firing (e.g. to protect Gemma/Gemini quota during a demo).
export const SYNC_ENABLED = process.env.SYNC_ENABLED !== 'false';

// ─── DPDP compliance (Step 4.5A) ──────────────────────────────────
// noticeVersion pins each consent to the notice text the user agreed to.
export const DPDP_NOTICE_VERSION = process.env.DPDP_NOTICE_VERSION
  || (IS_PRODUCTION ? required('DPDP_NOTICE_VERSION') : 'v1.0-2026-07');
export const DPDP_POLICY_URL = process.env.DPDP_POLICY_URL
  || (IS_PRODUCTION ? required('DPDP_POLICY_URL') : '/legal/privacy');
export const DPDP_GRIEVANCE_OFFICER_EMAIL = process.env.DPDP_GRIEVANCE_OFFICER_EMAIL
  || (IS_PRODUCTION ? required('DPDP_GRIEVANCE_OFFICER_EMAIL') : 'privacy@jobmesh.in');
// Reflects our use of Google AI Studio (cross-border processing).
export const DPDP_CROSS_BORDER_ENABLED = (process.env.DPDP_CROSS_BORDER_ENABLED ?? 'true') !== 'false';

// ─── Gemma JD extraction (Step 4.6) ───────────────────────────────
// Comma-separated API keys, ideally from DIFFERENT GCP projects (separate quota
// buckets, R2). All three have safe defaults so the server boots without them —
// extraction is simply disabled when no keys are configured.
export const GEMMA_API_KEYS = process.env.GEMMA_API_KEYS || '';
// Scraper JD extraction pool (batch). If empty, scraper falls back to GEMMA_API_KEYS.
export const GEMMA_SCRAPER_API_KEYS = process.env.GEMMA_SCRAPER_API_KEYS || '';
export const GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
export const GEMMA_BASE_URL = process.env.GEMMA_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

// SMTP config is optional — only used if EMAIL_USER + EMAIL_PASS are set.
export const EMAIL_CONFIG = process.env.EMAIL_USER && process.env.EMAIL_PASS
  ? {
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT, 10) || 587,
      secure: process.env.EMAIL_SECURE === 'true',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      to: process.env.EMAIL_TO || process.env.EMAIL_USER,
      from: process.env.EMAIL_FROM || `"Job Scraper Bot" <${process.env.EMAIL_USER}>`,
    }
  : null;
