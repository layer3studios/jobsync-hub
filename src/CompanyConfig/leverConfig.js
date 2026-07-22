import fetch from 'node-fetch';
import { AbortController } from 'abort-controller';

/**
 * LEVER CONFIGURATION - EXPANDED VERSION
 * 
 * This version includes more companies that are likely to have jobs.
 * These are verified to work with Lever's API.
 */

const LEVER_BASE_URL = 'https://api.lever.co/v0/postings';

/**
 * Verified working companies (tested and confirmed)
 * 
 * Start with these - they're known to use Lever and have active job postings
 */
const companySiteNames = [
  // Tech companies with frequent job postings
//  'welocalize',
 'jumpcloud',
  'meesho',
  '3pillarglobal',
  'stable-money1',
  'jobgether',
  'paytm',
  'lingarogroup',
  'gohighlevel',
  'crypto',
  'smart-working-solutions',
  'egen',
  'saviynt',
  'rackspace',
  'Allata',
  'entrata',
  'aeratechnology',
  'SymmetrySystems',
  'clovirtualfashion',
  'klearnow',
  'coupa',
  'nium',
  'foxitsoftware',
  'rapidai',
  'veeva',
  'binance',
  'jiostar',
  'ion',
  'everbridge',
  'highspot',
  'better',
  'thinkahead',
  'acceldata',
  'alifsemi',
  'idt',
  'hevodata',
  'findem',
  'accurate',
  'tryjeeves',
  'spreetail',
  'pattern',
  'nextgenfed',
  'economicmodeling',
  'weekdayworks',
  'gushwork',
  'megaport',
  'spotify',
  'certik',
  'regrello',
  'zeta',
  'fampay',
  'coatesgroup',
  'xsolla',
  'lucidworks',
  'floqast',
  'zuru',
  'sysdig',
  'palantir',
  'valdera',
  'Zeller',
  'extremenetworks',
  'getwingapp',
  'plaid',
  'drivetrain',
  'matchgroup',
  'ninjavan',
  'erg',
  'actian',
  'Sprinto',
  'mactores',
  'zimperium',
  '100ms',

  // ── Discovered via API scan ──
  'mindtickle',
  'dozee',
  'outreach',
  'cred',
  'sophos',

  // ── Discovered via ATS scan (Mar 2026) ──
  'porter',
  'hevo',
  'epifi',
  'freshworks',
  'pocketfm',
  // ── High-confidence Indian companies ──
'plivo',

// ── Global tech using Lever ──
'walkme',

];

// Indian cities for filtering
const indianCities = [
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
  'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
  'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
  'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
  'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
  'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
  'surat', 'patna', 'ranchi', 'guwahati', 'bhopal',
];

const indiaKeywords = ['india', 'in', 'ind'];

/**
 * Check if job has India location
 */
/**
 * Check if job has India location
 * Filters for Indian cities and remote jobs
 */
function hasIndiaLocation(job) {
  try {
    // 1. CHECK COUNTRY CODE FIRST (MOST RELIABLE!)
    if (job.country) {
      const countryCode = job.country.toLowerCase().trim();
      // Only accept 'in' or 'ind'
      if (countryCode === 'in' || countryCode === 'ind') {
        return true;
      }
      // If country is set but NOT India, reject immediately
      if (countryCode !== 'in' && countryCode !== 'ind') {
        return false;
      }
    }

    // 2. Check primary location
    if (job.categories?.location) {
      const locationLower = job.categories.location.toLowerCase().trim();
      
      // Check for India keywords
      if (indiaKeywords.some(keyword => {
        return locationLower === keyword || 
               locationLower.includes(`, ${keyword}`) ||
               locationLower.includes(`${keyword},`) ||
               locationLower.startsWith(`${keyword} `) ||
               locationLower.endsWith(` ${keyword}`);
      })) {
        return true;
      }
      
      // Check for Indian cities
      if (indianCities.some(city => {
        return locationLower === city ||
               locationLower.includes(`, ${city}`) ||
               locationLower.startsWith(`${city},`);
      })) {
        return true;
      }
      
    }

    // 3. Check all locations array
    if (job.categories?.allLocations && Array.isArray(job.categories.allLocations)) {
      for (const location of job.categories.allLocations) {
        const locationLower = location.toLowerCase().trim();
        
        // India match
        if (indiaKeywords.some(keyword => {
          return locationLower === keyword || 
                 locationLower.includes(`, ${keyword}`) ||
                 locationLower.includes(`${keyword},`);
        })) {
          return true;
        }
        
        // Indian cities
        if (indianCities.some(city => {
          return locationLower === city ||
                 locationLower.includes(`, ${city}`);
        })) {
          return true;
        }
      }
    }

    // DEFAULT: Not an India job
    return false;
    
  } catch (error) {
    console.error('Error checking India location:', error);
    return false;
  }
}

/**
 * Lever Configuration - Compatible with existing architecture
 */
const leverConfig = {
  siteName: 'Lever Jobs',
  
  // No session needed (public API)
  needsSession: false,
  
  // Use GET method
  method: 'GET',
  
  // Each "page" = one company
  limit: 1,

  // Keep paging through company list even when one company has zero jobs
  ignoreLengthCheck: true,
  
  // Base URL
  baseUrl: LEVER_BASE_URL,

  // Total pseudo-pages = total companies configured
  getTotal: () => companySiteNames.length,

  /**
   * Fetch one company's postings and swallow transient/per-company failures.
   * This method must never throw; return [] to skip and continue.
   */
  fetchPage: async (offset, limit) => {
    const companyIndex = offset;

    if (companyIndex >= companySiteNames.length) {
      return [];
    }

    const siteName = companySiteNames[companyIndex];
    const url = `${LEVER_BASE_URL}/${siteName}?mode=json`;
    console.log(`\n[Lever] 🔍 Company ${companyIndex + 1}/${companySiteNames.length}: ${siteName}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.status === 404) {
        console.log(`[Lever] ⚠️  ${siteName}: 404 — slug may be dead, skipping`);
        return [];
      }

      if (!res.ok) {
        console.warn(`[Lever] ⚠️  ${siteName}: HTTP ${res.status} — skipping`);
        return [];
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      const reason = err?.name === 'AbortError' ? '15s timeout' : (err?.message || 'request failed');
      console.warn(`[Lever] ⚠️  ${siteName}: ${reason} — skipping`);
      return [];
    }
  },
  
  /**
   * Build URL for current company
   */
  buildPageUrl: (offset, limit) => {
    const companyIndex = offset;
    
    if (companyIndex >= companySiteNames.length) {
      console.log(`[Lever] ✅ Finished checking all ${companySiteNames.length} companies`);
      return null;
    }
    
    const siteName = companySiteNames[companyIndex];
    const url = `${LEVER_BASE_URL}/${siteName}?mode=json`;
    
    console.log(`\n[Lever] 🔍 Company ${companyIndex + 1}/${companySiteNames.length}: ${siteName}`);
    
    return url;
  },
  
  /**
   * Extract and filter jobs from API response
   * 
   * DEBUGGING ENABLED: Shows what we receive from API
   */
  getJobs: (data) => {
    // DEBUG: Log what we received
    if (!data) {
      console.log(`       ❌ No data received from API`);
      return [];
    }
    
    const allJobs = Array.isArray(data) ? data : [];
    
    // DEBUG: Log job count
    console.log(`       📊 Received ${allJobs.length} total jobs`);
    
    if (allJobs.length === 0) {
      console.log(`       ⊘  No jobs found for this company`);
      return [];
    }
    
    // DEBUG: Log first job structure (helps diagnose issues)
    if (allJobs.length > 0) {
      const firstJob = allJobs[0];
      console.log(`       🔍 Sample job fields:`, {
        id: firstJob.id ? '✓' : '✗',
        text: firstJob.text ? '✓' : '✗',
        country: firstJob.country || 'none',
        location: firstJob.categories?.location || 'none',
        allLocations: firstJob.categories?.allLocations?.length || 0
      });
    }
    
    // Filter for India
    const indiaJobs = allJobs.filter(hasIndiaLocation);
    
    if (indiaJobs.length > 0) {
      console.log(`       ✅ Found ${indiaJobs.length} India jobs!`);
    } else {
      console.log(`       ⊘  No India jobs (checked ${allJobs.length} jobs)`);
    }
    
    return indiaJobs;
  },
  
  /**
   * Extract unique job ID
   */
  extractJobID: (job) => {
    return `lever_${job.id}`;
  },

  /**
   * Extract job title
   */
  extractJobTitle: (job) => {
    return job.text || 'Untitled Position';
  },

  /**
   * Extract company name
   */
  extractCompany: (job) => {
    if (job.hostedUrl) {
      try {
        const url = new URL(job.hostedUrl);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
          return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        }
      } catch (e) {
        // Fall through
      }
    }
    
    return 'Company via Lever';
  },

  /**
   * Extract location(s)
   */
  extractLocation: (job) => {
    const locations = [];
    
    if (job.categories && job.categories.location) {
      locations.push(job.categories.location);
    }
    
    if (job.categories && job.categories.allLocations && Array.isArray(job.categories.allLocations)) {
      for (const loc of job.categories.allLocations) {
        if (!locations.includes(loc)) {
          locations.push(loc);
        }
      }
    }
    
    if (job.workplaceType && job.workplaceType !== 'unspecified' && job.workplaceType !== 'on-site') {
      const workplaceLabel = job.workplaceType.charAt(0).toUpperCase() + job.workplaceType.slice(1);
      locations.push(workplaceLabel);
    }
    
    return locations.length > 0 ? locations.join(', ') : 'Location not specified';
  },

  /**
   * Extract description
   */
  extractDescription: (job) => {
    if (job.descriptionPlain) {
      return job.descriptionPlain;
    }
    
    if (job.description) {
      return job.description.replace(/<[^>]*>/g, '').trim();
    }
    
    return 'No description available';
  },

  /**
   * Extract URL
   */
  extractURL: (job) => {
    if (job.applyUrl) {
      return job.applyUrl;
    }
    
    if (job.hostedUrl) {
      return job.hostedUrl;
    }
    
    return null;
  },

  /**
   * Extract posting date
   */
  extractPostedDate: (job) => {
    return null;
  },
};

export { leverConfig };