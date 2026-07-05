import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSkill, matchesJobForProfile, RECENT_POSTING_DAYS,
} from '../../src/services/seeker/profile-match-helpers.js';

const NOW = new Date('2026-07-03T00:00:00Z').getTime();
const DAY = 86_400_000;
const recent = () => new Date(NOW - 2 * DAY);
const stale = () => new Date(NOW - (RECENT_POSTING_DAYS + 5) * DAY);

const PROFILE = { skills: [{ name: 'React' }, { name: 'Node' }, { name: 'AWS' }], totalExperienceYears: 3 };

function scrapedJob(over = {}) {
  return {
    Status: 'active', PostedDate: recent(), Location: 'Bangalore',
    autoTags: { roleCategory: 'Engineering' },
    parsedRequirements: {
      required_skills: ['ReactJS', 'NodeJS'], preferred_skills: [],
      min_experience_years: 2, max_experience_years: 5,
    },
    ...over,
  };
}

test('normalizeSkill collapses aliases to canonical', () => {
  assert.equal(normalizeSkill('ReactJS'), 'react');
  assert.equal(normalizeSkill('React.js'), 'react');
  assert.equal(normalizeSkill('Amazon Web Services'), 'aws');
  assert.equal(normalizeSkill('  KUBERNETES '), 'k8s');
});

test('normalizeSkill keeps + and # (C++, C#)', () => {
  assert.equal(normalizeSkill('C++'), 'c++');
  assert.equal(normalizeSkill('C#'), 'c#');
});

test('matchesJobForProfile passes at the min(3, |required|) threshold', () => {
  // 2 required → threshold 2; profile matches React+Node → pass.
  assert.equal(matchesJobForProfile(scrapedJob(), PROFILE, NOW), true);
  // 5 required → threshold 3; profile matches only React+Node+AWS = 3 → pass.
  const fiveReq = scrapedJob({ parsedRequirements: {
    required_skills: ['React', 'Node', 'AWS', 'Kafka', 'Rust'],
    preferred_skills: [], min_experience_years: 2, max_experience_years: 5,
  } });
  assert.equal(matchesJobForProfile(fiveReq, PROFILE, NOW), true);
  // Only 1 overlapping skill against a 2-required job → below threshold.
  const oneMatch = scrapedJob({ parsedRequirements: {
    required_skills: ['React', 'Kafka'], preferred_skills: [],
    min_experience_years: 2, max_experience_years: 5,
  } });
  const soloProfile = { skills: [{ name: 'React' }], totalExperienceYears: 3 };
  assert.equal(matchesJobForProfile(oneMatch, soloProfile, NOW), false);
});

test('matchesJobForProfile rejects out-of-band experience', () => {
  const senior = { skills: PROFILE.skills, totalExperienceYears: 20 };
  assert.equal(matchesJobForProfile(scrapedJob(), senior, NOW), false);
});

test('matchesJobForProfile handles both schemas (scraped + native)', () => {
  assert.equal(matchesJobForProfile(scrapedJob(), PROFILE, NOW), true);
  const native = {
    status: 'active', postedAt: recent(), location: 'Remote',
    parsedRequirements: {
      required_skills: ['react', 'node'], preferred_skills: [],
      min_experience_years: 1, max_experience_years: 6,
    },
  };
  assert.equal(matchesJobForProfile(native, PROFILE, NOW), true);
});

test('matchesJobForProfile is false without parsedRequirements', () => {
  assert.equal(matchesJobForProfile(scrapedJob({ parsedRequirements: undefined }), PROFILE, NOW), false);
});

test('matchesJobForProfile enforces the recency cutoff', () => {
  assert.equal(matchesJobForProfile(scrapedJob({ PostedDate: stale() }), PROFILE, NOW), false);
});
