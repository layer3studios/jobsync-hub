// FILE: src/core/pagination.js
// Decides whether to fetch another page from the ATS.

/**
 * @param {object} siteConfig
 * @param {Array} jobs       jobs returned on the current page
 * @param {number} offset    current pagination offset
 * @param {number} limit     items per page
 * @param {number} totalJobs running total known so far
 * @returns {boolean}
 */
export function shouldContinuePaging(siteConfig, jobs, offset, limit, totalJobs) {
  const pageJobs = Array.isArray(jobs) ? jobs : [];

  if (siteConfig.ignoreLengthCheck) {
    const total = siteConfig.getTotal ? siteConfig.getTotal(null) : Infinity;
    return (offset + limit) < total;
  }
  if (pageJobs.length === 0) return false;
  if (siteConfig.getTotal) return (offset + pageJobs.length) < totalJobs;
  if (pageJobs.length < limit) return false;
  return true;
}
