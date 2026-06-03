// FILE: src/core/jobTags/index.js
// Public entry point. Composes all sub-inferrers into one `generateJobTags`.

import { EMPTY_AUTO_TAGS, getPlainDescription } from './helpers.js';
import { inferTechStack } from './techStack.js';
import { inferRoleCategory } from './roleCategory.js';
import { inferExperienceBand } from './experience.js';
import { inferEntryLevel } from './entryLevel.js';
import { inferDomain, inferUrgency, inferEducation } from './extras.js';

export function generateJobTags(job = {}) {
  const roleCategory = inferRoleCategory(job);
  const experienceBand = inferExperienceBand(job);
  const isEntryLevel = inferEntryLevel(job, experienceBand);
  return {
    ...EMPTY_AUTO_TAGS,
    techStack: inferTechStack(job),
    roleCategory,
    experienceBand,
    isEntryLevel,
    domain: inferDomain(job),
    urgency: inferUrgency(job),
    education: inferEducation(job),
  };
}

export function getPlainTextForTagging(job = {}) {
  return getPlainDescription(job);
}
