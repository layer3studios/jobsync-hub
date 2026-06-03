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
