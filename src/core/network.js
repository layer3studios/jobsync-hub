// FILE: src/core/network.js
// Network helpers used by the scraper engine: session init + page fetch.

import fetch from 'node-fetch';
import { AbortController } from 'abort-controller';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';
const SESSION_INIT_TIMEOUT_MS = 60_000;
const PAGE_FETCH_TIMEOUT_MS = 30_000;

/** Initialize a session, handling CSRF where required. */
export async function initializeSession(siteConfig) {
  const headers = { 'User-Agent': USER_AGENT };

  // Greenhouse + Ashby use static public APIs — no session needed.
  if (siteConfig.siteName === 'Greenhouse Jobs' || siteConfig.siteName === 'Ashby Jobs') {
    return headers;
  }
  if (!siteConfig.needsSession) return headers;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_INIT_TIMEOUT_MS);
  try {
    console.log(`[${siteConfig.siteName}] initializing session`);
    const res = await fetch(siteConfig.baseUrl, { headers, signal: controller.signal });
    const cookies = res.headers.raw()['set-cookie'];
    if (cookies) {
      headers['Cookie'] = cookies.join('; ');
      const xsrf = cookies.find(c => c.startsWith('XSRF-TOKEN='));
      if (xsrf) {
        const token = xsrf.split(';')[0].split('=')[1];
        headers['X-XSRF-TOKEN'] = decodeURIComponent(token);
      }
    }
  } catch (err) {
    console.error(`[${siteConfig.siteName}] session init failed: ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  return headers;
}

/**
 * Fetch a single page of jobs from a site's API.
 * Returns null on 404 (skippable error, e.g. invalid Lever slug).
 * Throws on other errors.
 */
export async function fetchJobsPage(siteConfig, offset, limit, sessionHeaders) {
  // Config can provide its own custom fetch flow.
  if (typeof siteConfig.fetchPage === 'function') {
    return siteConfig.fetchPage(offset, limit);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);

  try {
    const opts = {
      method: siteConfig.method,
      headers: { ...sessionHeaders, ...(siteConfig.customHeaders || {}) },
      signal: controller.signal,
    };

    let url = siteConfig.apiUrl;

    if (siteConfig.method === 'POST') {
      const body = siteConfig.getBody(offset, limit, siteConfig.filterKeywords);
      if (typeof siteConfig.buildPageUrl === 'function') {
        url = siteConfig.buildPageUrl(offset, limit);
      }
      if (siteConfig.bodyType === 'form') {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(body).toString();
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    } else if (siteConfig.method === 'GET' && typeof siteConfig.buildPageUrl === 'function') {
      url = siteConfig.buildPageUrl(offset, limit, siteConfig.filterKeywords);
    }

    const res = await fetch(url, opts);

    if (res.status === 404) {
      console.warn(`[${siteConfig.siteName}] 404 at ${url} — skipping`);
      return null;
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}
