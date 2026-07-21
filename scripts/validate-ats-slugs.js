// FILE: scripts/validate-ats-slugs.js
// Dry-run health check for every ATS slug across the 8 platform configs (Workable is
// skipped — it self-discovers via an aggregator API). For each slug we hit ONLY the
// cheap list/health endpoint (never per-job detail endpoints) and classify liveness +
// whether the first page carries any India jobs. Writes three artifacts under
// reports/ats-validation/ and prints a per-ATS console summary. NEVER mutates a config.
//
// India detection REUSES the existing helpers — the config objects' own methods
// (Ashby/Greenhouse/Personio/Recruitee) and the shared isIndiaString (Lever /
// SmartRecruiters). Workday mirrors the exact inline city list from workdayConfig.js.
//
// Lever's `companySiteNames` and Recruitee's `companySlugs` are module-level consts
// that are NOT exported (and configs must not be modified), so those two lists are
// extracted from the source text. Everything else is read off the exported config.

import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ashbyConfig } from '../src/CompanyConfig/ashbyConfig.js';
import { greenhouseConfig } from '../src/CompanyConfig/greenhouseConfig.js';
import { personioConfig } from '../src/CompanyConfig/personioConfig.js';
import { smartRecruitersConfig } from '../src/CompanyConfig/smartRecruitersConfig.js';
import { workdayConfig } from '../src/CompanyConfig/workdayConfig.js';
import { recruiteeConfig } from '../src/CompanyConfig/recruiteeConfig.js';
import { isIndiaString } from '../src/core/Locationprefilters.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const CONCURRENCY = 5;        // parallel requests per ATS
const STAGGER_MS = 200;       // delay between each parallel worker's start
const TIMEOUT_MS = 15_000;    // per-request hard timeout
const USER_AGENT = 'Mozilla/5.0 (compatible; JobMeshATSValidator/1.0)';

const OUT_DIR = path.resolve(process.cwd(), 'reports', 'ats-validation');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATUS = {
  ALIVE_INDIA: 'ALIVE_WITH_INDIA_JOBS',
  ALIVE_EMPTY: 'ALIVE_NO_INDIA_JOBS',
  DEAD_404: 'DEAD_404',
  // Timeouts / 5xx / DNS / rate-limits / network errors. NOT dead — the slug is kept
  // and only surfaced in summary.md. Never enters prune-list.json.
  TRANSIENT_ERROR: 'TRANSIENT_ERROR',
};
const STATUS_RANK = { DEAD_404: 0, TRANSIENT_ERROR: 1, ALIVE_NO_INDIA_JOBS: 2, ALIVE_WITH_INDIA_JOBS: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── India detection helpers that have no importable config method ────────────
// Lever's helper is a non-exported module-level function; reuse the shared matcher.
function leverIsIndia(job) {
  const categories = job?.categories || {};
  if (isIndiaString(categories.location)) return true;
  if (Array.isArray(categories.allLocations) && categories.allLocations.some((l) => isIndiaString(l))) return true;
  return isIndiaString(job?.country);
}

// Verbatim copy of the city list inside workdayConfig.js (not exported). Kept identical
// so classification matches the real scraper exactly.
const WORKDAY_INDIAN_CITIES = [
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
  'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
  'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
  'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
  'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
  'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
  'surat', 'patna', 'ranchi', 'guwahati', 'bhopal',
];
function workdayIsIndia(locationsText) {
  const loc = (locationsText || '').toLowerCase();
  return loc.includes('india') || WORKDAY_INDIAN_CITIES.some((c) => loc.includes(c));
}

// Personio parser mirrors the config's options (1-job feeds return an object, not array).
const personioXmlParser = new XMLParser({
  ignoreAttributes: false, parseTagValue: false, trimValues: true,
  isArray: (name) => ['position', 'jobDescription'].includes(name),
});

// ─── Extract a module-level string array from config SOURCE (no import path) ───
async function extractStringArrayFromSource(relPath, constName) {
  const source = await readFile(path.resolve(HERE, relPath), 'utf8');
  const declIndex = source.indexOf(`const ${constName}`);
  if (declIndex === -1) return [];
  const open = source.indexOf('[', declIndex);
  const close = source.indexOf('];', open);
  const block = source.slice(open + 1, close);
  const slugs = [];
  for (const line of block.split('\n')) {
    const beforeComment = line.split('//')[0];      // drop trailing comment; skip fully-commented lines
    const match = beforeComment.match(/['"]([^'"]+)['"]/);
    if (match) slugs.push(match[1]);
  }
  return slugs;
}

// ─── HTTP with a hard timeout (AbortController) ───────────────────────────────
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Bounded, staggered pool: ≤CONCURRENCY in flight, worker starts offset by STAGGER
async function runPool(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const size = Math.min(CONCURRENCY, items.length);
  await Promise.all(
    Array.from({ length: size }, (_, k) => sleep(k * STAGGER_MS).then(runner)),
  );
  return results;
}

// ─── Per-ATS descriptors: how to list the slugs, request, and read the body ───
const ATS = [
  {
    key: 'ashby', label: 'Ashby',
    entries: () => ashbyConfig.companyBoardNames,
    display: (name) => name,
    request: (name) => ({ url: `https://api.ashbyhq.com/posting-api/job-board/${name}` }),
    async extract(res) {
      const data = await res.json();
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      return { jobsFound: jobs.length, indiaJobs: jobs.filter((j) => ashbyConfig.hasIndiaLocation(j)).length };
    },
  },
  {
    key: 'greenhouse', label: 'Greenhouse',
    entries: () => greenhouseConfig.companyBoardTokens,
    display: (token) => token,
    request: (token) => ({ url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs` }),
    async extract(res) {
      const data = await res.json();
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const india = jobs.filter((j) => greenhouseConfig.isIndiaLocation(j?.location?.name || '')).length;
      return { jobsFound: jobs.length, indiaJobs: india };
    },
  },
  {
    key: 'lever', label: 'Lever',
    entries: () => extractStringArrayFromSource('../src/CompanyConfig/leverConfig.js', 'companySiteNames'),
    display: (slug) => slug,
    request: (slug) => ({ url: `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1` }),
    async extract(res) {
      const data = await res.json();
      const jobs = Array.isArray(data) ? data : [];
      return { jobsFound: jobs.length, indiaJobs: jobs.filter(leverIsIndia).length, note: 'limit=1 sample' };
    },
  },
  {
    key: 'personio', label: 'Personio',
    entries: () => personioConfig.companyTargets,
    display: (t) => `${t.subdomain}.${t.tld}`,
    request: (t) => ({
      url: `https://${t.subdomain}.jobs.personio.${t.tld}/xml?language=en`,
      init: { headers: { Accept: 'application/xml,text/xml' } },
    }),
    async extract(res) {
      const xml = await res.text();
      const parsed = personioXmlParser.parse(xml);
      const positions = parsed?.['workzag-jobs']?.position || [];
      const arr = Array.isArray(positions) ? positions : [positions];
      return { jobsFound: arr.length, indiaJobs: arr.filter((j) => personioConfig.isIndiaJob(j)).length };
    },
  },
  {
    key: 'recruitee', label: 'Recruitee',
    entries: () => extractStringArrayFromSource('../src/CompanyConfig/recruiteeConfig.js', 'companySlugs'),
    display: (slug) => slug,
    request: (slug) => ({ url: `https://${slug}.recruitee.com/api/offers/` }),
    async extract(res) {
      const data = await res.json();
      const offers = Array.isArray(data?.offers) ? data.offers : [];
      return { jobsFound: offers.length, indiaJobs: offers.filter((o) => recruiteeConfig.hasIndiaLocation(o)).length };
    },
  },
  {
    key: 'smartrecruiters', label: 'SmartRecruiters',
    entries: () => smartRecruitersConfig.companyIdentifiers,
    display: (id) => id,
    request: (id) => ({ url: `https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=1&country=in` }),
    async extract(res) {
      const data = await res.json();
      const content = Array.isArray(data?.content) ? data.content : [];
      // country=in filters server-side; cross-check the returned page with isIndiaString.
      const india = content.filter((j) => {
        const loc = j?.location || {};
        const composed = loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
        return isIndiaString(composed) || String(loc.country || '').toLowerCase() === 'in';
      }).length;
      const total = typeof data?.totalFound === 'number' ? data.totalFound : content.length;
      return { jobsFound: content.length, indiaJobs: india, note: `totalFound=${total} (country=in)` };
    },
  },
  {
    key: 'workday', label: 'Workday',
    entries: () => workdayConfig.companyBoards,
    display: (b) => b.company,
    request: (b) => ({
      url: `https://${b.company}.${b.instance}.myworkdayjobs.com/wday/cxs/${b.company}/${b.site}/jobs`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      },
    }),
    async extract(res) {
      const data = await res.json();
      const posts = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
      const india = posts.filter((p) => workdayIsIndia(p?.locationsText)).length;
      const total = typeof data?.total === 'number' ? data.total : posts.length;
      return { jobsFound: posts.length, indiaJobs: india, note: `total=${total}, limit=1 sample` };
    },
  },
];

// ─── Classify one slug (never throws — DEAD_ERROR is the fallback) ────────────
async function checkOne(ats, entry) {
  const display = ats.display(entry);
  try {
    const { url, init } = ats.request(entry);
    const response = await fetchWithTimeout(url, init);
    if (response.status === 404) {
      console.log(`[${ats.label}] ${display} ✗ DEAD_404`);
      return { entry, display, status: STATUS.DEAD_404, jobs_found: 0, india_jobs: 0, notes: 'HTTP 404' };
    }
    if (!response.ok) {
      // Non-404 non-2xx (5xx, 403/429 rate-limit, etc.) — transient, keep the slug.
      console.log(`[${ats.label}] ${display} ⚠ TRANSIENT_ERROR (HTTP ${response.status})`);
      return { entry, display, status: STATUS.TRANSIENT_ERROR, jobs_found: 0, india_jobs: 0, notes: `HTTP ${response.status}` };
    }
    const { jobsFound, indiaJobs, note } = await ats.extract(response);
    const status = indiaJobs >= 1 ? STATUS.ALIVE_INDIA : STATUS.ALIVE_EMPTY;
    console.log(`[${ats.label}] ${display} ✓ ${jobsFound} jobs (${indiaJobs} India)`);
    return { entry, display, status, jobs_found: jobsFound, india_jobs: indiaJobs, notes: note || '' };
  } catch (err) {
    // Timeout / DNS / network / parse failure — transient, keep the slug.
    const notes = err?.name === 'AbortError' ? '15s timeout' : (err?.message || 'request failed');
    console.log(`[${ats.label}] ${display} ⚠ TRANSIENT_ERROR (${notes})`);
    return { entry, display, status: STATUS.TRANSIENT_ERROR, jobs_found: 0, india_jobs: 0, notes };
  }
}

// ─── Process one ATS end-to-end. Isolated so one platform can't kill the others.
async function processAts(ats) {
  let entries = [];
  try {
    entries = (await ats.entries()) || [];
  } catch (err) {
    console.error(`[${ats.label}] could not load slug list: ${err?.message || err}`);
    return { key: ats.key, label: ats.label, results: [] };
  }
  console.log(`[${ats.label}] checking ${entries.length} slugs…`);
  const results = await runPool(entries, (entry) => checkOne(ats, entry));
  return { key: ats.key, label: ats.label, results };
}

// ─── Artifact builders ────────────────────────────────────────────────────────
function buildSummaryMarkdown(reports) {
  const lines = ['# ATS slug validation', '', `_Generated ${new Date().toISOString()}_`, ''];
  for (const { label, results } of reports) {
    lines.push(`## ${label} (${results.length})`, '');
    lines.push('| slug | status | jobs_found | india_jobs | notes |', '| --- | --- | ---: | ---: | --- |');
    const sorted = [...results].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.display.localeCompare(b.display));
    for (const r of sorted) {
      lines.push(`| ${r.display} | ${r.status} | ${r.jobs_found} | ${r.india_jobs} | ${r.notes || ''} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildJsonArtifacts(reports) {
  const alive = {};
  const prune = {};
  for (const { key, results } of reports) {
    alive[key] = results.filter((r) => r.status === STATUS.ALIVE_INDIA).map((r) => r.entry);
    // Prune ONLY confirmed 404s. Transient errors are never removed.
    prune[key] = results.filter((r) => r.status === STATUS.DEAD_404).map((r) => r.entry);
  }
  return { alive, prune };
}

function printConsoleSummary(reports) {
  console.log('\n──────────── SUMMARY ────────────');
  let totalPrunable = 0;
  for (const { label, results } of reports) {
    const withIndia = results.filter((r) => r.status === STATUS.ALIVE_INDIA).length;
    const empty = results.filter((r) => r.status === STATUS.ALIVE_EMPTY).length;
    const dead = results.filter((r) => r.status === STATUS.DEAD_404).length;         // 404 only → prunable
    const transient = results.filter((r) => r.status === STATUS.TRANSIENT_ERROR).length; // kept
    totalPrunable += dead;
    const tag = `[${label}]`.padEnd(18);
    console.log(`${tag}alive-with-india: ${withIndia}   alive-empty: ${empty}   dead-404: ${dead}   transient: ${transient}   (of ${results.length})`);
  }
  console.log(`[total prunable slugs (404 only)]: ${totalPrunable}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  // allSettled: a thrown ATS still yields a report; others are unaffected.
  const settled = await Promise.allSettled(ATS.map((ats) => processAts(ats)));
  const reports = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { key: ATS[i].key, label: ATS[i].label, results: [] });

  await mkdir(OUT_DIR, { recursive: true });
  const { alive, prune } = buildJsonArtifacts(reports);
  await Promise.all([
    writeFile(path.join(OUT_DIR, 'summary.md'), buildSummaryMarkdown(reports), 'utf8'),
    writeFile(path.join(OUT_DIR, 'alive.json'), `${JSON.stringify(alive, null, 2)}\n`, 'utf8'),
    writeFile(path.join(OUT_DIR, 'prune-list.json'), `${JSON.stringify(prune, null, 2)}\n`, 'utf8'),
  ]);

  printConsoleSummary(reports);
  console.log(`\nArtifacts written to ${OUT_DIR}`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  // Last-resort guard — the per-ATS/per-slug layers already swallow their own errors.
  console.error('[validate-ats-slugs] fatal:', err);
  process.exitCode = 1;
});
