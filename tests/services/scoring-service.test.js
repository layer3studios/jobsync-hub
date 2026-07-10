import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { ensureResumeScoreIndexes, getResumeScoreForApplication } from '../../src/models/public/resume-score-model.js';
import { ensureContactIndexes, getContactForCompany } from '../../src/models/public/contact-model.js';
import { scoreApplication } from '../../src/services/public/scoring-service.js';

const COMPANY_ID = new ObjectId();
const JOB_ID = new ObjectId();
const APP_ID = new ObjectId();
const CONTACT_ID = new ObjectId();

const VALID_CONTACT_FIELDS = {
  linkedin_url: 'https://www.linkedin.com/in/asha-rao',
  github_url: 'https://github.com/asharao',
  portfolio_url: 'https://asha.dev',
  location: 'Bangalore, India',
};

/** A Gemma client returning the base score payload plus the given contact_fields. */
function gemmaReturning(contactFields) {
  const body = contactFields === undefined ? GEMMA_BASE : { ...GEMMA_BASE, contact_fields: contactFields };
  return () => ({ generateContent: async () => JSON.stringify(body) });
}

const loadContact = () => getContactForCompany(COMPANY_ID, CONTACT_ID);

const LONG_RESUME = 'React engineer with AWS experience. '.repeat(20);
const PARSED_REQUIREMENTS = { required_skills: ['React', 'AWS'], min_experience_years: 3 };
const GEMMA_BASE = {
  score: 82, matched_skills: ['React', 'AWS'], missing_skills: ['GraphQL'],
  bonus_skills: ['Docker'], experience_fit: 'good', location_fit: 'exact',
  notice_period_fit: 'within_30', explanation: 'Strong React and AWS match.',
};
const GEMMA_JSON = JSON.stringify(GEMMA_BASE);

function baseDeps(overrides = {}) {
  return {
    getResumeFileForApplication: async () => ({ storagePath: 'data/resumes/x.pdf' }),
    getResumeBuffer: async () => Buffer.from('%PDF'),
    extractTextFromPDF: async () => ({ text: LONG_RESUME }),
    getGemmaClient: () => ({ generateContent: async () => GEMMA_JSON }),
    ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_scores', 'applications', 'jobs', 'contacts');
  await ensureResumeScoreIndexes();
  await ensureContactIndexes();
  await (await col('applications')).insertOne({ _id: APP_ID, companyId: COMPANY_ID, jobId: JOB_ID, contactId: CONTACT_ID });
  await (await col('jobs')).insertOne({ _id: JOB_ID, companyId: COMPANY_ID, parsedRequirements: PARSED_REQUIREMENTS });
  await (await col('contacts')).insertOne({
    _id: CONTACT_ID, companyId: COMPANY_ID, email: 'asha@x.com', fullName: 'Asha Rao', phone: null,
    linkedinUrl: null, githubUrl: null, portfolioUrl: null, location: null, updatedAt: new Date(),
  });
}

test('happy path stores the full score', async () => {
  await scoreApplication(APP_ID, baseDeps());
  const stored = await getResumeScoreForApplication(APP_ID);
  assert.equal(stored.score, 82);
  assert.equal(stored.tier, 'good');
  assert.deepEqual(stored.matchedSkills, ['React', 'AWS']);
  assert.deepEqual(stored.missingSkills, ['GraphQL']);
  assert.equal(stored.experienceFit, 'good');
  assert.equal(stored.processingError, null);
  assert.equal(stored.resumeTextLength, LONG_RESUME.length);
});

test('no resume file → processingError stored, no throw', async () => {
  await scoreApplication(APP_ID, baseDeps({ getResumeFileForApplication: async () => null }));
  const stored = await getResumeScoreForApplication(APP_ID);
  assert.equal(stored.processingError, 'NO_RESUME_FILE');
  assert.equal(stored.score, null);
});

test('unreadable/short PDF → PDF_UNREADABLE', async () => {
  await scoreApplication(APP_ID, baseDeps({ extractTextFromPDF: async () => ({ text: 'too short' }) }));
  assert.equal((await getResumeScoreForApplication(APP_ID)).processingError, 'PDF_UNREADABLE');
});

test('extractTextFromPDF throwing → PDF_UNREADABLE', async () => {
  await scoreApplication(APP_ID, baseDeps({ extractTextFromPDF: async () => { throw new Error('scanned'); } }));
  assert.equal((await getResumeScoreForApplication(APP_ID)).processingError, 'PDF_UNREADABLE');
});

test('no parsedRequirements on posting → NO_JD_REQUIREMENTS', async () => {
  await (await col('jobs')).updateOne({ _id: JOB_ID }, { $unset: { parsedRequirements: '' } });
  await scoreApplication(APP_ID, baseDeps());
  assert.equal((await getResumeScoreForApplication(APP_ID)).processingError, 'NO_JD_REQUIREMENTS');
});

test('Gemma unavailable → GEMMA_UNAVAILABLE', async () => {
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: () => null }));
  assert.equal((await getResumeScoreForApplication(APP_ID)).processingError, 'GEMMA_UNAVAILABLE');
});

test('Gemma returns bad JSON → processingError stored', async () => {
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: () => ({ generateContent: async () => 'not json at all' }) }));
  const stored = await getResumeScoreForApplication(APP_ID);
  assert.ok(stored.processingError);
  assert.equal(stored.score, null);
});

test('score clamped to 0-100 and explanation truncated to 500', async () => {
  const raw = JSON.stringify({ score: 999, explanation: 'y'.repeat(900) });
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: () => ({ generateContent: async () => raw }) }));
  const stored = await getResumeScoreForApplication(APP_ID);
  assert.equal(stored.score, 100);
  assert.equal(stored.explanation.length, 500);
});

test('missing application → throws (programming error, not a scoring failure)', async () => {
  await assert.rejects(() => scoreApplication(new ObjectId(), baseDeps()));
});

// D9(m)
test('valid contact_fields → all four land on the contact after scoreApplication returns', async () => {
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: gemmaReturning(VALID_CONTACT_FIELDS) }));
  const contact = await loadContact();
  assert.equal(contact.linkedinUrl, 'https://www.linkedin.com/in/asha-rao');
  assert.equal(contact.githubUrl, 'https://github.com/asharao');
  assert.equal(contact.portfolioUrl, 'https://asha.dev');
  assert.equal(contact.location, 'Bangalore, India');
});

// D9(n) — backward compatibility.
test('no contact_fields in the Gemma response → contact untouched, scoring still succeeds', async () => {
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: gemmaReturning(undefined) }));
  const stored = await getResumeScoreForApplication(APP_ID);
  assert.equal(stored.score, 82);
  assert.equal(stored.processingError, null);
  const contact = await loadContact();
  assert.equal(contact.linkedinUrl, null);
  assert.equal(contact.githubUrl, null);
  assert.equal(contact.location, null);
});

// D9(o)
test('mixed valid/invalid URLs → only the valid ones land on the contact', async () => {
  await scoreApplication(APP_ID, baseDeps({
    getGemmaClient: gemmaReturning({
      linkedin_url: 'https://example.com/in/asha', // wrong host → dropped
      github_url: 'https://github.com/asharao',    // valid
      portfolio_url: 'not-a-url',                  // no scheme → dropped
      location: 'Bangalore',
    }),
  }));
  const contact = await loadContact();
  assert.equal(contact.linkedinUrl, null);
  assert.equal(contact.githubUrl, 'https://github.com/asharao');
  assert.equal(contact.portfolioUrl, null);
  assert.equal(contact.location, 'Bangalore');
});

// D9(p)
test('a throwing merge never fails scoring and never escapes scoreApplication', async () => {
  const stored = await scoreApplication(APP_ID, baseDeps({
    getGemmaClient: gemmaReturning(VALID_CONTACT_FIELDS),
    mergeContactEnrichment: async () => { throw new Error('contacts collection down'); },
  }));
  assert.equal(stored.score, 82);
  assert.equal((await getResumeScoreForApplication(APP_ID)).processingError, null);
  assert.equal((await loadContact()).linkedinUrl, null); // unchanged
});

// D9(q) — fill-nulls-only, end to end through the service.
test('an existing linkedinUrl is not overwritten by a later scoring pass', async () => {
  await (await col('contacts')).updateOne(
    { _id: CONTACT_ID }, { $set: { linkedinUrl: 'https://linkedin.com/in/original' } },
  );
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: gemmaReturning(VALID_CONTACT_FIELDS) }));
  const contact = await loadContact();
  assert.equal(contact.linkedinUrl, 'https://linkedin.com/in/original', 'existing value preserved');
  assert.equal(contact.githubUrl, 'https://github.com/asharao', 'null field still filled');
});

// D7 / V11 — contactFields must never reach the resume_scores row.
test('contactFields is peeled off and never persisted on the score row', async () => {
  await scoreApplication(APP_ID, baseDeps({ getGemmaClient: gemmaReturning(VALID_CONTACT_FIELDS) }));
  const row = await (await col('resume_scores')).findOne({ applicationId: APP_ID });
  assert.equal('contactFields' in row, false);
  assert.equal('contact_fields' in row, false);
});

test('a contact-less application (no contactId) scores fine and merges nothing', async () => {
  await (await col('applications')).updateOne({ _id: APP_ID }, { $unset: { contactId: '' } });
  const stored = await scoreApplication(APP_ID, baseDeps({ getGemmaClient: gemmaReturning(VALID_CONTACT_FIELDS) }));
  assert.equal(stored.score, 82);
  assert.equal(stored.processingError, null);
  assert.equal((await loadContact()).linkedinUrl, null);
});
