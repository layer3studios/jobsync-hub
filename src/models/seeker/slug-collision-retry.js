// FILE: src/models/seeker/slug-collision-retry.js
// Retry-on-E11000 helper for the unique `slug` index on the users collection. Slug is
// derived from the display name, and two people can share a name, so a plain insert
// races into a duplicate-key error (prod: E11000 slug_1 dup key "ashish-ranjan").
// This mirrors the JobID-collision pattern already shipped in posting-model.js: on a
// slug-index E11000, retry with a numeric suffix (base → base-2 → base-3 …) up to a
// hard cap. Any OTHER duplicate key (e.g. a googleId race) surfaces unchanged (D4).

const DUPLICATE_KEY_CODE = 11000;
const MAX_SLUG_ATTEMPTS = 100; // C9 — hard cap, never unlimited.

/** Thrown when every suffixed slug up to the cap was already taken. */
export class SlugCollisionExhausted extends Error {
  constructor(baseSlug, attempts) {
    super(`Could not create a unique slug for "${baseSlug}" after ${attempts} attempts`);
    this.name = 'SlugCollisionExhausted';
    this.baseSlug = baseSlug;
    this.attempts = attempts;
  }
}

/** True only for an E11000 tripped by the slug index — the sole retriable collision. */
export function isSlugCollision(err) {
  return err?.code === DUPLICATE_KEY_CODE && err?.keyPattern?.slug === 1;
}

/** The candidate slug for a 1-based attempt: attempt 1 → base, attempt N → base-N. */
export function slugForAttempt(baseSlug, attempt) {
  return attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
}

/**
 * Insert a user document, retrying on a slug-index collision with a numeric suffix.
 * `buildDoc(slug)` returns the full doc for a given slug (so every field except slug is
 * identical across attempts). Returns the inserted doc with its `_id`. Re-throws any
 * non-slug duplicate key immediately (no retry); throws SlugCollisionExhausted if all
 * MAX_SLUG_ATTEMPTS candidates are taken.
 */
export async function insertUserWithSlugRetry(collection, buildDoc, baseSlug) {
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const doc = buildDoc(slugForAttempt(baseSlug, attempt));
    try {
      const result = await collection.insertOne(doc);
      return { ...doc, _id: result.insertedId };
    } catch (err) {
      // A non-slug duplicate key (e.g. googleId race) is a genuine conflict — surface it.
      if (!isSlugCollision(err)) throw err;
    }
  }
  throw new SlugCollisionExhausted(baseSlug, MAX_SLUG_ATTEMPTS);
}
