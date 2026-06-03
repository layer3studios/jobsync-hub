// FILE: src/core/processor/mappers/index.js
// Mapper selector + barrel re-exports.

import { mapLeverJob } from './lever.js';
import { mapGreenhouseJob } from './greenhouse.js';
import { mapWorkableJob } from './workable.js';
import { mapAshbyJob } from './ashby.js';
import { mapRecruiteeJob } from './recruitee.js';
import { mapWorkdayJob } from './workday.js';

export { mapLeverJob, mapGreenhouseJob, mapWorkableJob, mapAshbyJob, mapRecruiteeJob, mapWorkdayJob };

/**
 * Choose the right mapper based on the site config's name.
 * Returns { mapper, getJobIdFallback } or null for unknown platforms.
 */
export function selectMapper(siteName) {
  const lower = String(siteName || '').toLowerCase();
  if (lower.includes('lever'))      return { mapper: mapLeverJob,      getJobIdFallback: raw => raw.id };
  if (lower.includes('greenhouse')) return { mapper: mapGreenhouseJob, getJobIdFallback: raw => String(raw.id) };
  if (lower.includes('ashby'))      return { mapper: mapAshbyJob,      getJobIdFallback: raw => raw.id };
  if (lower.includes('workable'))   return { mapper: mapWorkableJob,   getJobIdFallback: raw => raw.shortcode };
  if (lower.includes('recruitee'))  return { mapper: mapRecruiteeJob,  getJobIdFallback: raw => raw.id };
  if (lower.includes('workday'))    return {
    mapper: mapWorkdayJob,
    getJobIdFallback: raw => raw.bulletFields?.[0] ? `workday_${raw._company}_${raw.bulletFields[0]}` : null,
  };
  return null;
}
