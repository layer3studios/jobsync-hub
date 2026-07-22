import fetch from 'node-fetch';

const companySlugs = [
  // To find Recruitee companies that hire in India:
  // 1. Search Google: site:*.recruitee.com "India" OR "Bangalore" OR "Mumbai"
  // 2. The subdomain is the slug: https://{slug}.recruitee.com
  // 3. Verify: curl https://{slug}.recruitee.com/api/offers/ | jq '.offers | length'
  //
//   // Add verified slugs below:



'kcoverseaseducation',
'holepunch',
'samy1',
'o2h',
'frisbii',
'synapseanalytics',
'blackbelt',
'trafilea',
'somniosoftware',
'bettercollective',
'careersdeltacapita',
'xogene',
'jobsdeerns',
'devfinders',
'consultdss',
'infoprolearning',
'gustileder',

  'box8',    // Poncho Hospitality Pvt. Ltd. (5 India jobs)
  'mgid',
'transperfect',
'tether',
'fullcreative',  
    'hudsonmanpower',

    // ── Discovered via ATS scan (Mar 2026) ──
    'ampere',
    'ramco',
    // Verify each — Recruitee slug quality varies wildly
'penta',
'kontist',
];

const indianCities = [
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
  'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
  'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
  'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
  'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
  'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
  'surat', 'patna', 'ranchi', 'guwahati', 'bhopal'
];

const REQUEST_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return 3000 + Math.floor(Math.random() * 4000); // 3–7s between companies
}

function buildProxyUrl(targetUrl) {
  const proxyBase = process.env.WORKABLE_PROXY_URL;
  if (!proxyBase) return null;
  const separator = proxyBase.includes('?') ? '&' : '?';
  return `${proxyBase}${separator}url=${encodeURIComponent(targetUrl)}`;
}

async function fetchJsonFromUrl(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchRecruiteeOffers(slug) {
  const targetUrl = `https://${slug}.recruitee.com/api/offers/`;
  const proxyUrl = buildProxyUrl(targetUrl);

  const response = await fetchJsonFromUrl(proxyUrl || targetUrl);

  if (response.status === 404) {
    return { kind: 'not-found' };
  }

  if (!response.ok) {
    return { kind: 'failed', error: `HTTP ${response.status}` };
  }

  try {
    const data = await response.json();
    return { kind: 'ok', data };
  } catch {
    return { kind: 'failed', error: 'Invalid JSON response' };
  }
}

export const recruiteeConfig = {
  siteName: 'Recruitee Jobs',

  _allJobsQueue: [],
  _initialized: false,

  async initialize() {
    if (this._initialized) return;

    const via = process.env.WORKABLE_PROXY_URL ? 'proxy' : 'direct';
    console.log(`[Recruitee] Fetching jobs from ${companySlugs.length} companies via ${via}...`);

    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;

    for (const slug of companySlugs) {
      try {
        const result = await fetchRecruiteeOffers(slug);

        if (result.kind === 'not-found') {
          notFoundCount++;
          console.warn(`[Recruitee] ⚠️  ${slug}: 404 — skipping`);
          await sleep(randomDelay());
          continue;
        }

        if (result.kind !== 'ok') {
          errorCount++;
          console.error(`[Recruitee] ❌ ${slug}: ${result.error} — skipping`);
          await sleep(randomDelay());
          continue;
        }

        const data = result.data || {};
        const offers = Array.isArray(data.offers) ? data.offers : [];

        const indiaOffers = offers
          .filter(offer => this.hasIndiaLocation(offer))
          .map(offer => ({
            ...offer,
            _slug: slug,
            _companyName: offer.company_name || slug,
          }));

        if (indiaOffers.length > 0) {
          const companyName = indiaOffers[0]._companyName;
          console.log(`[Recruitee] ✅ ${slug} (${companyName}): ${indiaOffers.length} India jobs (${offers.length} total)`);
          this._allJobsQueue.push(...indiaOffers);
          successCount++;
        } else {
          const companyName = offers[0]?.company_name || slug;
          console.log(`[Recruitee]    ${slug} (${companyName}): ${offers.length} jobs, 0 in India`);
        }
      } catch (error) {
        errorCount++;
        console.error(`[Recruitee] ❌ ${slug}: ${error.message} — skipping`);
      }

      await sleep(randomDelay());
    }

    console.log(`[Recruitee] ✅ Summary: ${successCount} with India jobs | ${notFoundCount} not on Recruitee | ${errorCount} errors`);
    console.log(`[Recruitee] 📊 Total India jobs queued: ${this._allJobsQueue.length}`);
    this._initialized = true;
  },

  hasIndiaLocation(offer) {
    if (!Array.isArray(offer.locations) || offer.locations.length === 0) {
      return false;
    }

    return offer.locations.some(loc => {
      if (loc.country_code === 'IN') return true;
      if (loc.country && loc.country.toLowerCase() === 'india') return true;
      if (loc.city) {
        const cityLower = String(loc.city).toLowerCase();
        if (indianCities.some(c => cityLower.includes(c))) return true;
      }
      return false;
    });
  },

  async fetchPage(offset, limit) {
    if (!this._initialized) {
      await this.initialize();
    }
    const jobs = this._allJobsQueue.slice(offset, offset + limit);
    return { jobs, total: this._allJobsQueue.length };
  },

  getJobs(data) {
    return data.jobs || [];
  },

  getTotal(data) {
    return data.total || 0;
  },

  extractJobID(offer) {
    return `recruitee_${offer._slug}_${offer.id}`;
  },

  extractJobTitle(offer) {
    return offer.title;
  },

  extractCompany(offer) {
    return offer.company_name || offer._companyName || offer._slug;
  },

  extractLocation(offer) {
    if (!Array.isArray(offer.locations) || offer.locations.length === 0) return null;
    const first = offer.locations[0];
    return [first.city, first.state, first.country].filter(Boolean).join(', ') || null;
  },

  extractDescription(offer) {
    const parts = [offer.description, offer.requirements].filter(Boolean);
    return parts.join('\n\n') || '';
  },

  extractURL(offer) {
    return offer.careers_apply_url || offer.careers_url || null;
  },

  extractPostedDate(offer) {
    if (!offer.published_at) return null;
    const date = new Date(offer.published_at);
    return isNaN(date.getTime()) ? null : date;
  },
};
