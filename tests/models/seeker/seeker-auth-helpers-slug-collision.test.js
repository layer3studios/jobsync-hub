// FILE: tests/models/seeker/seeker-auth-helpers-slug-collision.test.js
// Regression guard for the prod E11000 slug_1 collision that 500'd Google signup when
// two users share a display name (e.g. "ashish-ranjan" derived from the same name for
// two different Google accounts). Exercises the retry helper that findOrCreateGoogleUser
// now delegates its insert to, with a fake collection so every collision sequence is
// deterministic (no DB, no real races). Non-slug duplicate keys must NOT be retried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertUserWithSlugRetry, SlugCollisionExhausted,
} from '../../../src/models/seeker/slug-collision-retry.js';

const BASE = 'ashish-ranjan';

/** An E11000 as the mongodb driver raises it for a given index keyPattern. */
function duplicateKeyError(keyPattern) {
  return Object.assign(new Error('E11000 duplicate key error'), {
    code: 11000, keyPattern, keyValue: {},
  });
}
const slugDup = () => duplicateKeyError({ slug: 1 });
const googleIdDup = () => duplicateKeyError({ googleId: 1 });

/**
 * Fake collection whose insertOne throws the scripted error for each 0-based attempt
 * (a non-Error entry = success). Records every doc it was asked to insert.
 */
function fakeCollection(script) {
  const docs = [];
  return {
    docs,
    async insertOne(doc) {
      const index = docs.length;
      docs.push(doc);
      const outcome = typeof script === 'function' ? script(index) : script[index];
      if (outcome instanceof Error) throw outcome;
      return { insertedId: `oid-${index}` };
    },
  };
}

const buildDoc = (slug) => ({ googleId: 'g-new', email: 'ashishar050488@gmail.com', name: 'Ashish Ranjan', slug });

test('happy path — no collision, inserts on the first try with the base slug', async () => {
  const col = fakeCollection([undefined]); // first insert succeeds
  const user = await insertUserWithSlugRetry(col, buildDoc, BASE);
  assert.equal(user.slug, BASE);
  assert.equal(user._id, 'oid-0');
  assert.equal(col.docs.length, 1);
});

test('single collision — retries with the -2 suffix and succeeds', async () => {
  const col = fakeCollection([slugDup(), undefined]);
  const user = await insertUserWithSlugRetry(col, buildDoc, BASE);
  assert.equal(user.slug, 'ashish-ranjan-2');
  assert.equal(col.docs.length, 2);
  assert.deepEqual(col.docs.map((d) => d.slug), ['ashish-ranjan', 'ashish-ranjan-2']);
});

test('three consecutive collisions — succeeds on the fourth attempt with the -4 suffix', async () => {
  const col = fakeCollection([slugDup(), slugDup(), slugDup(), undefined]);
  const user = await insertUserWithSlugRetry(col, buildDoc, BASE);
  assert.equal(user.slug, 'ashish-ranjan-4');
  assert.equal(col.docs.length, 4);
});

test('non-slug E11000 (googleId) — does NOT retry, throws immediately after one attempt', async () => {
  const err = googleIdDup();
  const col = fakeCollection([err]);
  const thrown = await insertUserWithSlugRetry(col, buildDoc, BASE).catch((e) => e);
  assert.equal(thrown, err); // the exact original error, unwrapped
  assert.equal(col.docs.length, 1); // no retry
});

test('exhaustion — 100 consecutive slug collisions throws SlugCollisionExhausted', async () => {
  const col = fakeCollection(() => slugDup()); // every attempt collides
  const thrown = await insertUserWithSlugRetry(col, buildDoc, BASE).catch((e) => e);
  assert.ok(thrown instanceof SlugCollisionExhausted);
  assert.equal(thrown.baseSlug, BASE);
  assert.equal(thrown.attempts, 100);
  assert.equal(col.docs.length, 100); // exactly the cap, never unlimited
});
