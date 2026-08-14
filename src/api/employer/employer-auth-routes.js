// FILE: src/api/employer/employer-auth-routes.js
// Employer authentication. Google sign-in gated by the admin-controlled
// signup gate; issues a separate httpOnly cookie (jm_employer_token) so seeker
// and employer sessions never interfere on the same browser.
//
// Exported as a factory so tests can inject a stubbed token verifier without
// monkey-patching ESM modules.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import {
  EMPLOYER_JWT_SECRET,
  EMPLOYER_JWT_EXPIRY,
  EMPLOYER_COOKIE_NAME,
  IS_PRODUCTION,
} from '../../env.js';
import {
  isEmployerSignupAllowed,
  findOrCreateEmployerGoogleUser,
  getEmployerUserById,
  getCompanyById,
  toPublicCompany,
} from '../../models/employer/index.js';
import { verifyEmployerGoogleIdToken } from '../../services/auth/verify-google-token-service.js';
import { toPublicEmployerUser } from './employer-user-projection.js';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';

const SIGNUP_GATED_MESSAGE =
  'Employer signup is not yet open. Contact support@jobmesh.in if you would like early access.';

const cookieOptions = () => ({
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: IS_PRODUCTION ? 'none' : 'lax', // SameSite=None requires Secure (R4)
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
});

function signEmployerToken(user) {
  return jwt.sign(
    { employerUserId: user._id.toString(), email: user.email },
    EMPLOYER_JWT_SECRET,
    { expiresIn: EMPLOYER_JWT_EXPIRY },
  );
}

// Stricter limiter on sign-in only — never global (R5), never on /me or /logout.
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
});

export function createEmployerAuthRouter({ verifyToken = verifyEmployerGoogleIdToken } = {}) {
  const router = Router();

  // POST /api/employer/auth/google
  router.post('/google', googleAuthLimiter, asyncHandler(async (req, res) => {
    const profile = await verifyToken(req.body?.credential);

    const allowed = await isEmployerSignupAllowed(profile.email);
    if (!allowed) throw new HttpError(403, SIGNUP_GATED_MESSAGE, 'EMPLOYER_SIGNUP_GATED');

    const user = await findOrCreateEmployerGoogleUser(profile);
    res.cookie(EMPLOYER_COOKIE_NAME, signEmployerToken(user), cookieOptions());
    res.json({ employerUser: toPublicEmployerUser(user) });
  }));

  // GET /api/employer/auth/me — reads the cookie directly; a missing cookie is
  // a normal "no session" 401, not a permission failure, so no requireEmployer.
  router.get('/me', asyncHandler(async (req, res) => {
    const token = req.cookies?.[EMPLOYER_COOKIE_NAME];
    if (!token) throw new HttpError(401, 'Unauthorized');

    let decoded;
    try {
      decoded = jwt.verify(token, EMPLOYER_JWT_SECRET);
    } catch {
      throw new HttpError(401, 'Unauthorized');
    }

    const user = await getEmployerUserById(decoded?.employerUserId);
    if (!user) throw new HttpError(401, 'Unauthorized');

    let company = null;
    if (user.companyId) {
      const found = await getCompanyById(user.companyId);
      if (found) company = toPublicCompany(found);
      // Orphan companyId can legitimately exist after an onboarding cleanup
      // race (R4); surface it as company:null rather than failing the request.
      else console.warn(`[employer/me] orphan companyId on employer user ${user._id}`);
    }
    res.json({ employerUser: toPublicEmployerUser(user), company });
  }));

  // POST /api/employer/auth/logout
  router.post('/logout', (_req, res) => {
    res.clearCookie(EMPLOYER_COOKIE_NAME, {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: IS_PRODUCTION ? 'none' : 'lax',
      path: '/',
    });
    res.json({ success: true });
  });

  return router;
}

export default createEmployerAuthRouter;
