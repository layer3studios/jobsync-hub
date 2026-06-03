// FILE: src/api/auth.routes.js
import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { GOOGLE_CLIENT_ID, JWT_SECRET, IS_PRODUCTION } from '../env.js';
import { findOrCreateGoogleUser, getUserById } from '../models/user/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: IS_PRODUCTION ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

function publicUser(user) {
  return {
    name: user.name,
    email: user.email,
    picture: user.picture,
    slug: user.slug,
    skills: Array.isArray(user.skills) ? user.skills : [],
    dailyGoal: typeof user.dailyGoal === 'number' ? user.dailyGoal : 5,
    appliedCount: typeof user.appliedCount === 'number' ? user.appliedCount : 0,
  };
}

// POST /api/auth/google
router.post('/google', asyncHandler(async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) throw new HttpError(400, 'Missing credential');

  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload) throw new HttpError(401, 'Invalid Google token');

  const { sub: googleId, email, name, picture } = payload;
  if (!googleId || !email || !name) throw new HttpError(401, 'Incomplete Google profile');

  const user = await findOrCreateGoogleUser({ googleId, email, name, picture });
  const token = jwt.sign(
    { userId: user._id.toString(), email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
  res.cookie('tj_token', token, COOKIE_OPTS);
  res.json({ user: publicUser(user) });
}));

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('tj_token', { httpOnly: true, secure: IS_PRODUCTION, sameSite: IS_PRODUCTION ? 'none' : 'lax', path: '/' });
  res.json({ success: true });
});

// GET /api/auth/me — returns the same shape as GET /api/me for consistency.
router.get('/me', asyncHandler(async (req, res) => {
  const token = req.cookies?.tj_token;
  if (!token) throw new HttpError(401, 'Unauthorized');

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { throw new HttpError(401, 'Unauthorized'); }

  const user = await getUserById(decoded.userId);
  if (!user) throw new HttpError(401, 'Unauthorized');
  res.json(publicUser(user));
}));

export default router;
