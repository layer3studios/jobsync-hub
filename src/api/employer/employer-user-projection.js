// FILE: src/api/employer/employer-user-projection.js
// The ONE client-safe shape of an employer user. Extracted from
// employer-auth-routes so /auth/me and /me agree by construction — two projections
// of the same row is how a settings page ends up showing a stale timezone the
// session payload never carried.
//
// googleId is never exposed. `picture` is Google's URL and `avatarUrl` is the
// user's upload; both travel, and the client prefers avatarUrl (see the comment on
// displayPictureFor).

import { toEmployerUserProfile } from '../../models/employer/employer-user-profile-model.js';

export function toPublicEmployerUser(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    picture: user.picture || null,
    companyId: user.companyId || null,
    ...toEmployerUserProfile(user),
  };
}

/**
 * Which image to actually render.
 *
 * THE UPLOAD ALWAYS WINS, and permanently. A Google picture URL is a signed link
 * that rotates and eventually 404s, so once someone has uploaded their own photo we
 * stop deferring to Google entirely rather than falling back to it when the upload
 * is missing — a "fallback" there would resurrect a photo the user replaced.
 * Both null means the caller draws initials.
 */
export function displayPictureFor(user) {
  return user?.avatarUrl || user?.picture || null;
}

export default toPublicEmployerUser;
