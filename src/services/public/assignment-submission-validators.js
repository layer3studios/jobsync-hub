// FILE: src/services/public/assignment-submission-validators.js
// Validation for the assignment fields on the PUBLIC apply form. This endpoint is
// unauthenticated, so nothing here trusts its input: every field is parsed, bounded
// and normalized before it reaches a model. Each rule throws HttpError(400, msg,
// CODE) and returns the normalized value, matching apply-validators.js.

import { HttpError } from '../../middleware/error-handler-middleware.js';

const MAX_LINKS = 5;
const MAX_LINK_LENGTH = 2048;
const MAX_PROFILE_URL_LENGTH = 255;
const MAX_NOTES_LENGTH = 5000;

// Control chars except tab (\t = \x09) and newline (\n = \x0A).
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Parse a string into a URL, or null when it is not one. */
function parseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * Submission links. https ONLY — that single check is what rejects `javascript:`,
 * `data:` and `http:` in one go, rather than blacklisting schemes we thought of.
 * addedAt comes from the injected `now` so the apply transaction can retry its
 * callback without the timestamps drifting between attempts.
 */
export function validateSubmissionLinks(raw, now = new Date()) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Links must be a list.', 'INVALID_LINK');
  }
  if (raw.length > MAX_LINKS) {
    throw new HttpError(400, `You can add at most ${MAX_LINKS} links.`, 'TOO_MANY_LINKS');
  }

  const seen = new Set();
  const links = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length > MAX_LINK_LENGTH) {
      throw new HttpError(400, 'That link is not a valid https URL.', 'INVALID_LINK');
    }
    const url = parseUrl(entry);
    if (!url || url.protocol !== 'https:') {
      throw new HttpError(400, 'Links must be full https:// URLs.', 'INVALID_LINK');
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue; // dedupe by exact string, first occurrence wins
    seen.add(normalized);
    links.push({ url: normalized, addedAt: now });
  }
  return links;
}

/**
 * Optional GitHub profile URL.
 *
 * A two-segment path (github.com/user/repo) is a REPOSITORY, not a profile — and it
 * is accepted anyway. Nudging someone toward their profile URL is a job for the
 * form (Chunk 6); hard-rejecting a working link they pasted into an OPTIONAL field,
 * over a formatting opinion, is hostile and costs us real candidates. Store what
 * they gave us.
 */
export function validateGithubProfileUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const url = parseUrl(raw);
  const invalid = new HttpError(400, 'Enter a valid GitHub URL, or leave it blank.', 'INVALID_GITHUB_URL');

  if (raw.length > MAX_PROFILE_URL_LENGTH || !url || url.protocol !== 'https:') throw invalid;
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && !host.endsWith('.github.com')) throw invalid;
  // At least one non-empty path segment — bare github.com is not a profile.
  if (url.pathname.split('/').filter(Boolean).length < 1) throw invalid;
  return raw;
}

// Paths that are demonstrably not a person's profile.
const LINKEDIN_NON_PROFILE_PATHS = ['/company/', '/school/', '/posts/', '/jobs/'];

/**
 * Optional LinkedIn profile URL.
 *
 * The hostname check is ENDS-WITH 'linkedin.com', not equality with
 * 'www.linkedin.com'. LinkedIn serves country subdomains — in.linkedin.com,
 * uk.linkedin.com, sg.linkedin.com — and Indian candidates very often copy their
 * URL from the in. regional site. Anchoring on 'www.' would reject a large share of
 * our actual applicant base on their own valid profile link. This is not obvious
 * from reading the happy path, hence the comment.
 *
 * lnkd.in is refused: it is LinkedIn's shortener, so it is an opaque redirect we
 * cannot verify points at a profile at all.
 */
export function validateLinkedinProfileUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const url = parseUrl(raw);
  const invalid = new HttpError(400, 'Enter a valid LinkedIn profile URL, or leave it blank.', 'INVALID_LINKEDIN_URL');

  if (raw.length > MAX_PROFILE_URL_LENGTH || !url || url.protocol !== 'https:') throw invalid;
  const host = url.hostname.toLowerCase();
  if (host === 'lnkd.in' || host.endsWith('.lnkd.in')) throw invalid;
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) throw invalid;

  const pathname = url.pathname.toLowerCase();
  if (!pathname.includes('/in/')) throw invalid;
  if (LINKEDIN_NON_PROFILE_PATHS.some((segment) => pathname.includes(segment))) throw invalid;
  return raw;
}

/**
 * Seeker notes. Control characters are stripped BEFORE the length is measured, so
 * invisible padding cannot buy extra characters.
 *
 * Deliberately does NOT reject "<script". This is markdown rendered by
 * react-markdown with raw HTML disabled, so a script tag is inert text on the way
 * out, and a frontend take-home legitimately contains one inside a fenced code
 * block — rejecting it would break a real use case to prevent nothing. Same
 * reasoning as the Chunk 2 assignment validators. Do not "harden" this.
 */
export function validateSeekerNotes(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Notes must be text.', 'INVALID_NOTES');
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (cleaned.length > MAX_NOTES_LENGTH) {
    throw new HttpError(400, 'Notes must be 5000 characters or fewer.', 'INVALID_NOTES');
  }
  return cleaned;
}
