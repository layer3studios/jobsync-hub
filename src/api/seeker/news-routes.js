// FILE: src/api/news.routes.js
// Tech / job-market news proxied from the public Hacker News (Algolia) API.
// Cached in-memory for 60 min so we never hit the upstream on every page load,
// and so no third-party key/host is exposed to the browser.
import { Router } from 'express';
import fetch from 'node-fetch';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const MAX_ITEMS = 5;
// Hacker News front page = current top tech stories (always fresh — hours/days old,
// not the all-time-popular results that a keyword `search` returns).
const HN_ENDPOINT = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=12';

let cache = { items: [], fetchedAt: 0 };

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); }
  catch { return 'news.ycombinator.com'; }
}

async function loadNews() {
  const res = await fetch(HN_ENDPOINT, { timeout: 8000 });
  if (!res.ok) throw new Error(`HN responded ${res.status}`);
  const data = await res.json();
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  return hits
    .filter(h => h.title)
    .slice(0, MAX_ITEMS)
    .map(h => {
      const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      return {
        id: h.objectID,
        title: h.title,
        url,
        source: hostnameOf(url),
        points: h.points || 0,
        comments: h.num_comments || 0,
        postedAt: h.created_at,
      };
    });
}

// GET /api/news — cached tech/job news headlines.
router.get('/', asyncHandler(async (_req, res) => {
  const isFresh = Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (isFresh && cache.items.length) {
    return res.json({ items: cache.items, cachedAt: cache.fetchedAt });
  }
  try {
    const items = await loadNews();
    cache = { items, fetchedAt: Date.now() };
    res.json({ items, cachedAt: cache.fetchedAt });
  } catch (err) {
    // Degrade gracefully: serve stale cache if present, else an empty list
    // (the frontend hides the widget rather than breaking the layout).
    console.error('[news] fetch failed:', err?.message || err);
    if (cache.items.length) {
      return res.json({ items: cache.items, cachedAt: cache.fetchedAt, stale: true });
    }
    res.json({ items: [] });
  }
}));

export default router;
