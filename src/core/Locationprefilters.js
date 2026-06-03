// FILE: src/core/Locationprefilters.js
// India-specific location detection + ATS field normalizers.

const INDIA_LOCATIONS = [
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
  'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
  'kolkata', 'ahmedabad', 'india', 'remote', 'work from home',
  'wfh', 'pan india', 'anywhere in india',
];

const INDIAN_CITIES = [
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
  'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
  'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
  'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
  'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
  'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
  'surat', 'patna', 'ranchi', 'guwahati', 'bhopal',
];

/** True if the string mentions India or any known Indian city. */
export function isIndiaString(location) {
  if (!location || typeof location !== 'string') return false;
  const lower = location.toLowerCase().trim();
  if (!lower) return false;
  if (lower.includes('india')) return true;
  if (lower === 'in' || lower === 'ind') return true;
  return INDIAN_CITIES.some(city => lower.includes(city));
}

/** Normalize workplace-type strings to: Remote / Hybrid / On-site / null. */
export function normalizeWorkplaceType(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase().trim();
  if (['remote', 'fully remote', 'work from home'].includes(lower)) return 'Remote';
  if (['hybrid', 'hybrid job'].includes(lower)) return 'Hybrid';
  if (['on-site', 'onsite', 'on_site', 'office'].includes(lower)) return 'On-site';
  return null;
}

/** Normalize employment-type strings to a small JobMesh taxonomy. */
export function normalizeEmploymentType(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase().trim();
  if (['full-time', 'fulltime', 'full_time', 'permanent'].includes(lower)) return 'Full-time';
  if (['part-time', 'parttime', 'part_time'].includes(lower)) return 'Part-time';
  if (['internship', 'intern'].includes(lower)) return 'Internship';
  if (['contract', 'temporary', 'temp'].includes(lower)) return 'Contract';
  if (lower === 'freelance') return 'Freelance';
  return raw;
}

/**
 * True if the job should be kept based on its location fields.
 * Missing / empty location → keep (defensive default).
 */
export function universalLocationPreFilter(job, options = {}) {
  const fields = options.locationFields || ['location', 'Location', 'city', 'office'];
  let text = null;
  for (const field of fields) {
    if (job[field]) { text = String(job[field]); break; }
    if (field.includes('.')) {
      let value = job;
      for (const part of field.split('.')) {
        value = value?.[part];
        if (!value) break;
      }
      if (value) { text = String(value); break; }
    }
  }
  if (!text || text.trim() === '') return true;
  const lower = text.toLowerCase();
  return INDIA_LOCATIONS.some(term => lower.includes(term));
}

export function createLocationPreFilter(options = {}) {
  return (job) => universalLocationPreFilter(job, options);
}
