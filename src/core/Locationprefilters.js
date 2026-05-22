/**
 * Location Pre-Filter for India-based job matching
 */

const INDIA_LOCATIONS = [
    'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
    'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
    'kolkata', 'ahmedabad', 'india', 'remote', 'work from home',
    'wfh', 'pan india', 'anywhere in india'
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

/**
 * Returns true if the given string refers to a location in India.
 * Checks for "India", country code "IN", and known Indian city names.
 */
export function isIndiaString(location) {
    if (!location || typeof location !== 'string') return false;
    const lower = location.toLowerCase().trim();
    if (!lower) return false;
    if (lower.includes('india')) return true;
    if (lower === 'in' || lower === 'ind') return true;
    return INDIAN_CITIES.some(city => lower.includes(city));
}

/**
 * Normalize workplace type strings from various ATS platforms
 * into a consistent set: 'Remote', 'Hybrid', 'On-site', or null.
 */
export function normalizeWorkplaceType(raw) {
    if (!raw) return null;
    const lower = String(raw).toLowerCase().trim();
    if (lower === 'remote' || lower === 'fully remote' || lower === 'work from home') return 'Remote';
    if (lower === 'hybrid' || lower === 'hybrid job') return 'Hybrid';
    if (lower === 'on-site' || lower === 'onsite' || lower === 'on_site' || lower === 'office') return 'On-site';
    if (lower === 'unspecified' || lower === 'n/a') return null;
    return null;
}

/**
 * Normalize employment type strings from various ATS platforms
 * into: 'Full-time', 'Part-time', 'Internship', 'Contract', 'Temporary', 'Freelance', or the raw value.
 */
export function normalizeEmploymentType(raw) {
    if (!raw) return null;
    const lower = String(raw).toLowerCase().trim();
    if (lower === 'full-time' || lower === 'fulltime' || lower === 'full_time' || lower === 'permanent') return 'Full-time';
    if (lower === 'part-time' || lower === 'parttime' || lower === 'part_time') return 'Part-time';
    if (lower === 'internship' || lower === 'intern') return 'Internship';
    if (lower === 'contract' || lower === 'temporary' || lower === 'temp') return 'Contract';
    if (lower === 'freelance') return 'Freelance';
    return raw;
}

/**
 * Returns true if job should be kept, false if rejected.
 * null / undefined / empty string location → PASS (keep the job)
 */
export function universalLocationPreFilter(job, options = {}) {
    const locationFields = options.locationFields || ['location', 'Location', 'city', 'office'];
    let locationText = null;

    for (const field of locationFields) {
        if (job[field]) {
            locationText = String(job[field]);
            break;
        }
        if (field.includes('.')) {
            const parts = field.split('.');
            let value = job;
            for (const part of parts) {
                value = value?.[part];
                if (!value) break;
            }
            if (value) {
                locationText = String(value);
                break;
            }
        }
    }

    // null, undefined, or empty string → PASS
    if (!locationText || locationText.trim() === '') {
        return true;
    }

    const lower = locationText.toLowerCase();

    // If location matches any India location term → PASS
    if (INDIA_LOCATIONS.some(term => lower.includes(term))) {
        return true;
    }

    // Not in India → FAIL
    return false;
}

export function createLocationPreFilter(options = {}) {
    return (job) => universalLocationPreFilter(job, options);
}
