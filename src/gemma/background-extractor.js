// FILE: src/gemma/background-extractor.js
// Fire-and-forget JD extraction. Accepts either a scraped job (PascalCase:
// JobTitle/Description/Company) or a native posting (camelCase: title/description,
// source:'native') and $sets parsedRequirements on its jobs-collection doc (C10).
// Idempotent: skips a doc that already has parsedRequirements. Callers append
// .catch(...) — this never blocks or throws into a request path (D6).

import { col } from '../Db/connection.js';
import { EMPLOYER_JD_EXTRACTION_ENABLED, SCRAPER_JD_EXTRACTION_ENABLED } from '../env.js';
import { extractRequirementsFromJD } from './extract-requirements.js';
import { getEmployerAiClient, getScraperAiClient } from './gemma-runtime.js';

/** Map a job doc (either shape) to { title, company, description }. */
function readJdFields(jobDoc) {
  if (jobDoc.source === 'native') {
    return { title: jobDoc.title, company: jobDoc.company ?? null, description: jobDoc.description };
  }
  return { title: jobDoc.JobTitle, company: jobDoc.Company, description: jobDoc.Description };
}

/**
 * Extract requirements for one job and persist them. `client` is injectable for
 * tests; it defaults to the real-time (scoring) pool, which is correct for the
 * employer post-create path. The scraper's batch loop passes its own pool's
 * client explicitly — see tasks/scraper-extraction-hook.js.
 */
export async function extractAndStoreRequirements(jobDoc, client = null) {
  if (!jobDoc || jobDoc.parsedRequirements) return; // idempotent skip

  // Each origin has its own switch and its own tier. An explicit client (the
  // scraper's batch loop) always wins over the defaults resolved here.
  const isNative = jobDoc.source === 'native';
  if (isNative && !EMPLOYER_JD_EXTRACTION_ENABLED) return;
  if (!isNative && !SCRAPER_JD_EXTRACTION_ENABLED) return;

  const aiClient = client ?? (isNative ? getEmployerAiClient() : getScraperAiClient());
  if (!aiClient) throw new Error('extractAndStoreRequirements: Gemma is not configured');

  const parsedRequirements = await extractRequirementsFromJD(readJdFields(jobDoc), aiClient);

  const jobs = await col('jobs');
  await jobs.updateOne({ _id: jobDoc._id }, { $set: { parsedRequirements } });
}

export default extractAndStoreRequirements;
