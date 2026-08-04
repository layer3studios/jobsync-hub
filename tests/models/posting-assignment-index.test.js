// FILE: tests/models/posting-assignment-index.test.js
// The index proof for the assignment→postings lookup on the shared `jobs`
// collection, and the record of a DEFECT it uncovered.
//
// jobs_assignmentId_native (Chunk 1) is declared as:
//   key    { assignmentId: 1 }
//   filter { source: 'native', assignmentId: { $type: 'objectId' } }
//
// MongoDB only considers a partial index when the query PROVES it selects a subset
// of the indexed documents. Repeating source:'native' proves half of that. But the
// planner's subset check is conservative and does NOT reason that an equality on an
// ObjectId value implies { $type: 'objectId' } — so the natural query shape
// { source:'native', companyId, assignmentId } cannot use the index at all. It is
// not even a rejected plan; it is never a candidate.
//
// The tests below pin all of it: what the query actually does today, that the
// $type clause is the specific cause, and the negative control for the source
// clause. See the KNOWN DEFECT test for the recommended fix and its migration note.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { ensurePostingIndexes } from '../../src/models/employer/posting-model.js';
import { countJobsUsingAssignment, listJobTitlesUsingAssignment } from '../../src/models/employer/assignment-model.js';

const companyId = new ObjectId();
const assignmentId = new ObjectId();

const NATIVE_COUNT = 50;
const ATTACHED_COUNT = 5;
const SCRAPED_COUNT = 50;
const TOTAL_COUNT = NATIVE_COUNT + SCRAPED_COUNT;

// The exact filter countJobsUsingAssignment / listJobTitlesUsingAssignment build.
const MODEL_QUERY = { source: 'native', companyId, assignmentId };

/**
 * Walk winningPlan's inputStage chain looking for a stage by name. explain() nests
 * differently per plan shape — FETCH → inputStage → IXSCAN for an indexed read, a
 * bare COLLSCAN otherwise — so recursing beats hardcoding a depth.
 */
function findStage(plan, stageName) {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.stage === stageName) return plan;
  const branches = [plan.inputStage, ...(plan.inputStages ?? []), plan.queryPlan, plan.child];
  for (const branch of branches) {
    const found = findStage(branch, stageName);
    if (found) return found;
  }
  return null;
}

const winningPlan = (explained) => explained.queryPlanner?.winningPlan ?? null;
const indexNameOf = (plan) => findStage(plan, 'IXSCAN')?.indexName ?? null;

async function explain(filter) {
  const jobs = await col('jobs');
  const explained = await jobs.find(filter).explain('executionStats');
  return {
    explained,
    plan: winningPlan(explained),
    indexName: indexNameOf(winningPlan(explained)),
    stats: explained.executionStats,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });

async function reset() {
  await dropCollections('jobs');
  await ensurePostingIndexes();
  const jobs = await col('jobs');
  const docs = [];
  for (let i = 0; i < NATIVE_COUNT; i += 1) {
    docs.push({
      source: 'native', companyId, slug: `native-role-${i}`, title: `Native Role ${i}`,
      status: 'active', assignmentId: i < ATTACHED_COUNT ? assignmentId : null,
    });
  }
  for (let i = 0; i < SCRAPED_COUNT; i += 1) {
    // Scraped ATS rows: PascalCase, no `source`, no companyId. A few carry a stray
    // assignmentId to prove the source filter — not luck — is what excludes them.
    docs.push({
      JobID: `ats-${i}`, JobTitle: `Scraped Role ${i}`, Company: 'SomeCorp',
      ...(i < ATTACHED_COUNT ? { assignmentId } : {}),
    });
  }
  await jobs.insertMany(docs);
}

test('the model query is index-backed and bounded — it never scans the collection', async () => {
  const { plan, indexName, stats } = await explain(MODEL_QUERY);
  assert.ok(findStage(plan, 'IXSCAN'), `expected an IXSCAN stage, got: ${JSON.stringify(plan)}`);
  assert.ok(indexName, 'the query must be served by some index, never a COLLSCAN');
  assert.equal(stats.nReturned, ATTACHED_COUNT);
  // Whichever index wins, it must not degrade into reading every scraped job.
  assert.ok(
    stats.totalDocsExamined <= NATIVE_COUNT,
    `docsExamined ${stats.totalDocsExamined} must stay within the company's native postings (${NATIVE_COUNT}), not ${TOTAL_COUNT}`,
  );
});

/**
 * KNOWN DEFECT — Chunk 1's jobs_assignmentId_native is never eligible.
 *
 * This test asserts the CURRENT (wrong) behaviour on purpose, so it fails loudly
 * the moment someone fixes the index and forgets to revisit this file.
 *
 * Recommended fix (posting-model.js ensurePostingIndexes): drop the
 * `assignmentId: { $type: 'objectId' }` clause and make the key compound —
 *     { companyId: 1, assignmentId: 1 } with partialFilterExpression { source: NATIVE }
 * That is eligible for the model query (which already repeats source:'native'),
 * gives exact bounds on both fields, and matches the companyId-first access pattern.
 * The explicit assignmentId:null rows Chunk 1 writes do get indexed, which is the
 * price of eligibility and is one cheap key per native posting.
 *
 * MIGRATION NOTE: createIndex with the same NAME and different options throws
 * IndexOptionsConflict on boot. The fix therefore needs either a new index name or
 * an explicit dropIndex first — it is not a safe in-place edit. That is why this
 * chunk records the defect instead of quietly changing a merged index.
 */
test('KNOWN DEFECT: the $type clause makes jobs_assignmentId_native ineligible', async () => {
  const { explained, indexName, stats } = await explain(MODEL_QUERY);

  assert.notEqual(
    indexName, 'jobs_assignmentId_native',
    'if this now passes, the index was fixed — delete this test and tighten the one above',
  );
  assert.equal(indexName, 'jobs_companyId_source_status_native');

  // Not merely out-planned: never a candidate. It is absent from rejectedPlans too.
  const rejected = JSON.stringify(explained.queryPlanner.rejectedPlans ?? []);
  assert.equal(rejected.includes('jobs_assignmentId_native'), false);

  // The cost of the defect: 50 docs read to return 5.
  assert.equal(stats.totalDocsExamined, NATIVE_COUNT);
  assert.equal(stats.nReturned, ATTACHED_COUNT);
});

test('proof of cause: adding the $type clause makes the same query use the index', async () => {
  const { indexName, stats } = await explain({
    ...MODEL_QUERY, assignmentId: { $eq: assignmentId, $type: 'objectId' },
  });
  assert.equal(indexName, 'jobs_assignmentId_native');
  assert.equal(stats.nReturned, ATTACHED_COUNT);
  assert.equal(stats.totalDocsExamined, ATTACHED_COUNT); // 5, not 50 — what we should get
  assert.equal(stats.totalKeysExamined, ATTACHED_COUNT);
});

test('and hinting it directly confirms the index itself is sound, only its eligibility is not', async () => {
  const jobs = await col('jobs');
  const explained = await jobs.find(MODEL_QUERY).hint('jobs_assignmentId_native').explain('executionStats');
  assert.equal(indexNameOf(winningPlan(explained)), 'jobs_assignmentId_native');
  assert.equal(explained.executionStats.nReturned, ATTACHED_COUNT);
  assert.equal(explained.executionStats.totalDocsExamined, ATTACHED_COUNT);
});

/**
 * NEGATIVE CONTROL for the source clause — this is why the source:'native' filter is
 * mandatory in every `jobs` query. Without it no partial index on this collection is
 * eligible, and the read collapses to a full scan across every scraped ATS row.
 */
test('NEGATIVE CONTROL: dropping source:native costs every partial index and scans everything', async () => {
  const { plan, indexName, stats } = await explain({ companyId, assignmentId });
  assert.notEqual(indexName, 'jobs_assignmentId_native');
  assert.ok(findStage(plan, 'COLLSCAN'), `expected a COLLSCAN, got: ${JSON.stringify(plan)}`);
  assert.equal(stats.totalDocsExamined, TOTAL_COUNT); // all 100, scraped rows included
  assert.equal(stats.nReturned, ATTACHED_COUNT);
});

test('the result set contains no scraped job', async () => {
  const jobs = await col('jobs');
  const results = await jobs.find(MODEL_QUERY).toArray();
  assert.equal(results.length, ATTACHED_COUNT);
  for (const doc of results) {
    assert.equal(doc.source, 'native');
    assert.equal(doc.JobID, undefined);
    assert.ok(doc.title.startsWith('Native Role'));
  }
});

test('the model helpers return the same bounded, native-only set', async () => {
  assert.equal(await countJobsUsingAssignment(companyId, assignmentId), ATTACHED_COUNT);
  const titles = await listJobTitlesUsingAssignment(companyId, assignmentId);
  assert.equal(titles.length, ATTACHED_COUNT);
  assert.ok(titles.every((entry) => entry.title.startsWith('Native Role')));
  assert.equal(await countJobsUsingAssignment(new ObjectId(), assignmentId), 0);
});
