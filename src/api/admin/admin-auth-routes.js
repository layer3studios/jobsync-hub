// FILE: src/api/admin/admin-auth-routes.js
// Admin authentication. Google sign-in restricted to identities that already
// exist (and are active) in admin_users — there is no admin self-signup. Issues a
// separate httpOnly cookie (jm_admin_token) whose options are copied exactly from
// jm_employer_token; only the name and maxAge (8h default) differ. Exported as a
// factory so tests can inject a stubbed Google verifier without patching ESM.

import { Router } from 'express';
import jwt from 'jsonwebtoken';

import { JWT_SECRET, ADMIN_JWT_TTL_HOURS, IS_PRODUCTION } from '../../env.js';
import { findAdminByEmail, markAdminLoggedIn, activateAdminByInviteToken } from '../../models/admin/index.js';
import { verifyEmployerGoogleIdToken } from '../../services/auth/verify-google-token-service.js';
import { requireAdmin } from '../../middleware/require-admin-middleware.js';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';

const ADMIN_COOKIE_NAME = 'jm_admin_token';

// COPIED EXACTLY from jm_employer_token cookieOptions (C9); only maxAge differs.
const cookieOptions = () => ({
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: IS_PRODUCTION ? 'none' : 'lax', // SameSite=None requires Secure
  maxAge: ADMIN_JWT_TTL_HOURS * 60 * 60 * 1000,
  path: '/',
});

// Never expose internal fields — only the identity contract the frontend needs.
function toPublicAdmin(admin) {
  return { adminUserId: admin._id.toString(), email: admin.email, role: admin.role };
}

function signAdminToken(admin) {
  return jwt.sign(
    { adminUserId: admin._id.toString(), email: admin.email, role: admin.role },
    JWT_SECRET,
    { expiresIn: `${ADMIN_JWT_TTL_HOURS}h` },
  );
}

export function createAdminAuthRouter({ verifyToken = verifyEmployerGoogleIdToken } = {}) {
  const router = Router();

  // POST /api/admin/auth/google
  router.post('/google', asyncHandler(async (req, res) => {
    const idToken = req.body?.idToken;
    if (!idToken) throw new HttpError(400, 'idToken required', 'MISSING_ID_TOKEN');

    // verifyToken throws HttpError(401, 'Invalid Google token', ...) on failure.
    const profile = await verifyToken(idToken);

    // Invite acceptance: match by token (not by active-email lookup), activate the
    // pending row, consume the token. Non-invite logins are unchanged below.
    const inviteToken = req.body?.inviteToken;
    if (inviteToken) {
      let admin;
      try {
        admin = await activateAdminByInviteToken(inviteToken, profile.email); // audit: admin_invite_accepted
      } catch (err) {
        if (err?.code === 'INVITE_EMAIL_MISMATCH' || err?.code === 'INVITE_INVALID') {
          throw new HttpError(403, err.message, err.code);
        }
        throw err;
      }
      res.cookie(ADMIN_COOKIE_NAME, signAdminToken(admin), cookieOptions());
      res.json({ admin: toPublicAdmin(admin) }); // activation already stamped lastLoginAt
      return;
    }

    const admin = await findAdminByEmail(profile.email);
    if (!admin) throw new HttpError(403, 'Not an admin', 'NOT_AN_ADMIN');

    res.cookie(ADMIN_COOKIE_NAME, signAdminToken(admin), cookieOptions());
    await markAdminLoggedIn(admin._id);
    res.json({ admin: toPublicAdmin(admin) });
  }));

  // GET /api/admin/auth/me — hydrates the frontend AdminContext.
  router.get('/me', requireAdmin, (req, res) => {
    res.json({ admin: req.adminUser });
  });

  // POST /api/admin/auth/logout — clear options mirror set options minus maxAge.
  router.post('/logout', (_req, res) => {
    res.clearCookie(ADMIN_COOKIE_NAME, {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: IS_PRODUCTION ? 'none' : 'lax',
      path: '/',
    });
    res.json({ ok: true });
  });

  return router;
}

export default createAdminAuthRouter;
