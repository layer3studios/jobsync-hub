// FILE: src/services/admin/google-indexing-client.js
// Thin client for Google's Indexing API, authenticated with a service account via
// google-auth-library's JWT (already a dependency for OAuth — nothing new added).
//
// Returns null when unconfigured, the same shape email-client.js uses: a missing
// credential is a normal, logged, non-throwing condition. The server boots fine
// without indexing, the worker idles, and the admin page says "not configured".
//
// NEVER logs or returns the private key, and never the raw credential blob.

import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import { GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON } from '../../env.js';

const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const PUBLISH_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

let warnedMissing = false;

/**
 * The env value is either the raw JSON (starts with '{') or a path to the key
 * file. Anything unparseable is treated as "not configured" rather than throwing
 * at boot — a malformed credential must not take the server down.
 */
export function readCredentials(raw = GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  try {
    const json = value.startsWith('{') ? value : fs.readFileSync(value, 'utf8');
    const parsed = JSON.parse(json);
    if (!parsed?.client_email || !parsed?.private_key) return null;
    return parsed;
  } catch (err) {
    // The message may contain a file path but never the key itself.
    console.warn(`[indexing] could not read service-account credentials: ${err.message}`);
    return null;
  }
}

/**
 * Build the client, or null when unconfigured. `publishUrl` resolves to
 * { ok, status, error } and never throws — the worker branches on status
 * (429 is quota, not failure).
 */
export function buildIndexingClient(deps = {}) {
  const {
    credentials = readCredentials(),
    fetchImpl = fetch,
    JwtClass = JWT,
  } = deps;

  if (!credentials) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.log('[indexing] GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON not set — URL submission disabled');
    }
    return null;
  }

  const auth = new JwtClass({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [INDEXING_SCOPE],
  });

  async function publishUrl(url, type) {
    let headers;
    try {
      headers = await auth.getRequestHeaders(PUBLISH_ENDPOINT);
    } catch (err) {
      return { ok: false, status: 401, error: `auth failed: ${err.message}` };
    }

    let response;
    try {
      response = await fetchImpl(PUBLISH_ENDPOINT, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type }),
      });
    } catch (err) {
      return { ok: false, status: 0, error: `network: ${err.message}` };
    }

    if (response.ok) return { ok: true, status: response.status };

    // The body carries Google's reason; keep it short and credential-free.
    const detail = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    };
  }

  return { publishUrl };
}

export default buildIndexingClient;
